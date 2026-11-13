'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {service,sleep}=require('./helpers/service');
const {StateStore,validate}=require('../runtime/state-store');
const {Tables}=require('../runtime/tables');
const game=require('../games/doudizhu');
async function login(s,name){const c=await s.client();await c.call('identify',{name});c.identity=await c.wait('identified');return c;}
async function table(s){const a=await login(s,'Audit-A'),b=await login(s,'Audit-B'),c=await login(s,'Audit-C');await a.call('create_room',{game:'doudizhu',options:{totalRounds:1}});const room=await a.wait('room_created');for(const p of [b,c]){await p.call('join_room',{roomId:room.roomId});await p.wait('room_joined');}for(const p of [a,b,c])await p.call('player_ready',{ready:true});await a.call('start_game');const views=await Promise.all([a,b,c].map(p=>p.wait('game_started')));return {players:[a,b,c],room,views};}

test('requests commit before acknowledgement; duplicates, stale moves and conflicting IDs do not act twice',async()=>{
 const s=await service();try{
  const {players,room,views}=await table(s);const actor=views[0].state.currentPlayer,p=players[actor];
  const data={score:3,expectedRevision:views[0].state.revision};
  assert.equal((await p.call('game_move',data,'bid-once')).ok,true);
  const first=s.snapshot().rooms.find(r=>r.id===room.roomId).state;
  assert.equal(first.landlord,actor);assert.equal(first.hands[actor].length,20);
  assert.equal((await p.call('game_move',data,'bid-once')).ok,true);
  assert.deepEqual(s.snapshot().rooms[0].state,first);
  p.send('game_move',{cards:[]},'bid-once');assert.equal((await p.wait('error',m=>m.requestId==='bid-once')).code,'REQUEST_CONFLICT');
  assert.equal((await p.call('game_move',{cards:[first.hands[actor][0].id],expectedRevision:0})).code,'STALE_STATE');
  assert.deepEqual(s.snapshot().rooms[0].state,first);
  assert.equal((await p.call('game_move',{cards:[first.hands[actor][0].id,first.hands[actor][0].id]})).ok,false);
  assert.deepEqual(s.snapshot().rooms[0].state,first);
  const before=fs.statSync(s.file).mtimeMs;
  p.send('ping');await p.wait('pong');await p.call('unknown-command');
  assert.equal(fs.statSync(s.file).mtimeMs,before,'read-only/invalid traffic must not rewrite the checkpoint');
  assert.equal((await fetch(s.origin+'/api/health')).status,200);
 }finally{await s.close();}
});

test('all-offline host departure recovers a host; occupied seats remain unavailable; concurrent vacancy claim has one winner',async()=>{
 const s=await service();try{
  const {players,room,views}=await table(s),[a,b,c]=players;
  b.ws.close();c.ws.close();await sleep(70);
  await a.call('leave_room');await a.wait('left_room');
  const b2=await s.client();await b2.call('identify',{identityToken:b.identity.identityToken});await b2.wait('identified');await b2.call('join_room',{roomId:room.roomId});const resumed=await b2.wait('room_joined');
  assert.equal(resumed.players.find(p=>p.index===1).isHost,true);assert.equal(resumed.playerIndex,1);assert.deepEqual(resumed.state.hands[1],views[1].state.hands[1]);
  const x=await login(s,'Audit-X'),y=await login(s,'Audit-Y');
  const claims=await Promise.all([x.call('join_room',{roomId:room.roomId}),y.call('join_room',{roomId:room.roomId})]);assert.equal(claims.filter(r=>r.ok).length,1);
  const list=await(await fetch(s.origin+'/api/rooms')).json();assert.equal(list.rooms[0].seats[2].vacant,false);assert.equal(list.rooms[0].seats[2].online,false);assert.equal(list.rooms[0].paused,true);
  const saved=s.snapshot().rooms[0];assert.equal(saved.players.length,3);assert.equal(new Set(saved.players.map(p=>p.index)).size,3);
 }finally{await s.close();}
});

test('logout revokes bearer but preserves identity; normalized names and rejected options remain consistent',async()=>{
 const s=await service();try{
  const a=await login(s,'Ｎame');const token=a.identity.identityToken,id=a.identity.userId;
  await a.call('logout');await a.wait('logged_out');
  const old=await s.client();old.send('identify',{identityToken:token});assert.equal((await old.wait('error')).code,'IDENTITY_INVALID');
  const fresh=await login(s,' name ');assert.equal(fresh.identity.userId,id);
  assert.equal((await fresh.call('create_room',{game:'doudizhu',options:{totalRounds:99}})).code,'OPTION_INVALID');
  assert.equal(s.snapshot().rooms.length,0);assert.equal(s.snapshot().identities.length,1);
  assert.equal((await fetch(s.origin+'/api/users')).status,404);
 }finally{await s.close();}
});

test('departed final-round vote is removed in both views; only three current occupants can extend once',async()=>{
 const s=await service();try{
  const {players:[a,b,c],room}=await table(s);
  await a.call('game_move',{action:'continue_vote',vote:'yes'});await b.call('game_move',{action:'continue_vote',vote:'yes'});
  await b.call('leave_room');await b.wait('left_room');
  const x=await login(s,'Vote replacement');await x.call('join_room',{roomId:room.roomId});const joined=await x.wait('room_joined');
  assert.equal(joined.state.continueVoting.votes[1],null);assert.equal(joined.state.board.continueVoting.votes[1],null);
  await c.call('game_move',{action:'continue_vote',vote:'yes'});assert.equal(s.snapshot().rooms[0].state.totalRounds,1);
  await x.call('game_move',{action:'continue_vote',vote:'yes'});assert.equal(s.snapshot().rooms[0].state.totalRounds,4);
  await x.call('game_move',{action:'continue_vote',vote:'yes'});assert.equal(s.snapshot().rooms[0].state.totalRounds,4);
 }finally{await s.close();}
});

test('version-1 migration and graceful restart preserve identities, hands, score, history, vacancies and turn',async()=>{
 const s=await service();try{
  const {players,room}=await table(s),actor=s.snapshot().rooms[0].state.currentPlayer;
  await players[actor].call('game_move',{score:3});await players[(actor+1)%3].call('leave_room');
  const before=s.snapshot();await s.stop();const checkpoint=s.snapshot();
  // Simulate the exact older version: no revisions or deal identifier.
  delete checkpoint.rooms[0].revision;delete checkpoint.rooms[0].state.dealNumber;
  fs.writeFileSync(s.file,JSON.stringify(checkpoint));await s.start();
  const c=await s.client();await c.call('identify',{identityToken:players[actor].identity.identityToken});await c.wait('identified');await c.call('join_room',{roomId:room.roomId});const recovered=await c.wait('room_joined');
  assert.equal(recovered.playerIndex,actor);assert.deepEqual(recovered.state.hands[actor],before.rooms[0].state.hands[actor]);assert.deepEqual(recovered.state.cumulativeScore,before.rooms[0].state.cumulativeScore);
  assert.deepEqual(recovered.state.roundHistory,before.rooms[0].state.roundHistory);assert.equal(recovered.state.currentPlayer,before.rooms[0].state.currentPlayer);assert.equal(recovered.state.paused,true);
  const after=s.snapshot();assert.equal(after.identities.length,before.identities.length);assert.deepEqual(after.rooms[0].state,checkpoint.rooms[0].state);
 }finally{await s.close();}
});

test('checkpoint validation refuses corrupt records and write failure emits no success acknowledgement',()=>{
 assert.throws(()=>validate({version:1,identities:[['token',{id:'x',name:'A'}],['token2',{id:'y',name:'ａ'}]],rooms:[]}),/Duplicate/);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ddz-store-')),file=path.join(dir,'state.json');
 try{
  const ws={readyState:1,sent:[],send(m){this.sent.push(JSON.parse(m));},close(){}};const sockets=new Set([ws]);let failure;
  const runtime=new Tables(file,sockets,e=>failure=e);
  runtime.store.save=()=>{throw Error('simulated full disk');};
  runtime.dispatch(ws,{type:'identify',data:{name:'Disk test'},requestId:'disk'});
  assert.ok(failure);assert.equal(ws.sent.length,0);assert.equal(runtime.failed,true);
  fs.writeFileSync(file,'broken checkpoint');const store=new StateStore(file);assert.throws(()=>store.load());assert.equal(fs.readFileSync(file,'utf8'),'broken checkpoint');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('last explicit departure removes playing and completed tables and notifies spectators',async()=>{
 for(const phase of ['playing','over']){
  const s=await service();try{
   const {players,room}=await table(s);
   if(phase==='over'){
    await s.stop();const snapshot=s.snapshot();snapshot.rooms[0].state.phase='over';snapshot.rooms[0].state.winner=0;
    fs.writeFileSync(s.file,JSON.stringify(snapshot));await s.start();
    for(let i=0;i<3;i++){
     const p=await s.client();await p.call('identify',{identityToken:players[i].identity.identityToken});await p.call('join_room',{roomId:room.roomId});players[i]=p;
    }
   }
   const watcher=await s.client();await watcher.call('watch_room',{roomId:room.roomId});await watcher.wait('room_watched');
   await players[0].call('leave_room');await players[1].call('leave_room');
   assert.equal(s.snapshot().rooms[0].players.length,1);
   assert.equal((await players[2].call('leave_room')).ok,true);
   await watcher.wait('room_dissolved');assert.equal(s.snapshot().rooms.length,0);
   assert.equal((await(await fetch(s.origin+'/api/rooms')).json()).rooms.length,0);
   assert.deepEqual(await(await fetch(s.origin+'/api/room-exists/'+room.roomId)).json(),{exists:false});
   await s.stop();await s.start();assert.equal(s.snapshot().rooms.length,0);
  }finally{await s.close();}
 }
});

test('startup prunes legacy empty tables but preserves occupied offline games and identities exactly',async()=>{
 const s=await service();try{
  await table(s);await s.stop();
  const before=s.snapshot();
  for(const phase of ['lobby','ready','playing']){
   before.rooms.push({...JSON.parse(JSON.stringify(before.rooms[0])),id:'EMPTY-'+phase,phase,players:[],hostIndex:null,readyPlayers:[]});
  }
  before.futureField={preserve:true};fs.writeFileSync(s.file,JSON.stringify(before));
  await s.start();const after=s.snapshot();
  assert.deepEqual(after,{...before,rooms:[before.rooms[0]]});
  const rooms=(await(await fetch(s.origin+'/api/rooms')).json()).rooms;
  assert.equal(rooms.length,1);assert.equal(rooms[0].playerCount,3);
  assert.ok(rooms[0].seats.every(p=>!p.online && !p.vacant));
  const mtime=fs.statSync(s.file).mtimeMs;await s.stop();await s.start();
  assert.equal(fs.statSync(s.file).mtimeMs,mtime,'cleanup is idempotent');
 }finally{await s.close();}
});

test('30 complete rounds conserve cards and zero-sum scores across repeated games',()=>{
 for(let round=0;round<30;round++){
  const s=game.createState();s._options={bidMode:'score',totalRounds:1};s._playerCount=3;game.initGame(s,3);
  assert.equal(new Set(s.hands.flat().concat(s.bottomCards).map(c=>c.id)).size,54);
  assert.equal(game.handleMove({score:3},s,s.currentPlayer),null);
  for(let moves=0;moves<200 && s.phase!=='over';moves++){
    const actor=s.currentPlayer,hand=s.hands[actor];
    const possible=hand.find(c=>!s.lastPlay||game.canBeat(game.detectType([c]),s.lastPlay.play));
    const action=possible?{cards:[possible.id]}:{cards:[]};assert.equal(game.handleMove(action,s,actor),null);
  }
  assert.equal(s.phase,'over');assert.equal(s.cumulativeScore.reduce((a,b)=>a+b,0),0);assert.equal(s.roundHistory.length,1);assert.ok(s.gameMultiplier<=128);
 }
});
