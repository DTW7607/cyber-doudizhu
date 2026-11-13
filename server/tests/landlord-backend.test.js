// Local fork integration checks. Never contacts a deployed server.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('anonymous identity, all-room listing, private state, reconnect, restart and two-person dissolution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamenest-backend-'));
  const stateFile = path.join(dir, 'state.json');
  const port = 21000 + (process.pid % 10000);
  let child; const clients = [];
  async function start() {
    child = spawn(process.execPath, ['server.js'], {cwd: path.join(__dirname,'..'), env:{...process.env,PORT:String(port),HOST:'127.0.0.1',GAMENEST_STATE_FILE:stateFile,NODE_ENV:'test',TEST_OFFLINE_VOTE_MS:'120'},stdio:['ignore','pipe','pipe']});
    let log=''; child.stderr.on('data',b=>log+=b);
    for(let i=0;i<100;i++) {try {if((await fetch(`http://127.0.0.1:${port}/api/rooms`)).ok)return;}catch{} await sleep(30);}
    throw Error('Server failed: '+log);
  }
  async function stop() { if(child && child.exitCode===null) {child.kill('SIGTERM'); await new Promise(r=>child.once('exit',r));} }
  async function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`); const messages=[];
    ws.on('message',b=>messages.push(JSON.parse(b)));
    await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
    const c={ws,messages,send(type,data){ws.send(JSON.stringify({type,data}))},async wait(type,pred=()=>true){for(let i=0;i<100;i++){const n=messages.findIndex(m=>m.type===type&&pred(m));if(n>=0)return messages.splice(n,1)[0];await sleep(20)}throw Error('Timeout '+type+' '+JSON.stringify(messages));}};
    clients.push(c); return c;
  }
  async function identify(c,name,identityToken) {c.send('identify',identityToken?{identityToken}:{name});return c.wait('identified');}
  try {
    await start();
    const a=await client(), b=await client(), c=await client();
    const ai=await identify(a,'Ａlice'), bi=await identify(b,'Bob'), ci=await identify(c,'Carol');
    assert.equal(ai.name,'Alice');
    const duplicate=await client();
    for (const name of ['Al\u200bice', 'Ali\u202ece']) { duplicate.send('identify',{name}); assert.equal((await duplicate.wait('error')).code,'NAME_INVALID'); }
    a.send('set_name',{name:'Al\u200bice'});assert.equal((await a.wait('error')).code,'NAME_INVALID');
    duplicate.send('identify',{identityToken:'invalid'});assert.equal((await duplicate.wait('error')).code,'IDENTITY_INVALID');
    const settings=await client();await identify(settings,'Settings');
    settings.send('create_room',{game:'doudizhu',options:{bidMode:'rob'}});assert.equal((await settings.wait('room_created')).options.bidMode,'rob');
    settings.send('leave_room',{});await settings.wait('left_room');
    settings.send('create_room',{game:'doudizhu'});assert.equal((await settings.wait('room_created')).options.bidMode,'score');
    settings.send('leave_room',{});await settings.wait('left_room');
    a.send('create_room',{game:'chess'});assert.equal((await a.wait('error')).message,'无效的游戏类型');
    a.send('create_room',{game:'doudizhu',options:{totalRounds:3,bidMode:'score'}});const created=await a.wait('room_created');const roomId=created.roomId;assert.equal(created.options.bidMode,'score');assert.equal(created.options.playTimeLimit,0);
    b.send('join_room',{roomId});await b.wait('room_joined');c.send('join_room',{roomId});await c.wait('room_joined');
    let listed=await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json();
    assert.equal(listed.rooms[0].status,'full');assert.equal(listed.rooms[0].canJoin,false);
    a.send('add_bot',{});assert.equal((await a.wait('error')).code,'ACTION_DISABLED');
    for(const x of [a,b,c])x.send('player_ready',{});await sleep(50);a.send('start_game',{});
    const started=await a.wait('game_started');await b.wait('game_started');await c.wait('game_started');
    assert.equal(started.state.bidMode,'score');assert.equal(started.state.hands[0].length,17);assert.ok(started.state.hands[0].every(Boolean));
    assert.ok(started.state.hands[1].every(x=>x===null));assert.ok(started.state.board.hands[2].every(x=>x===null));
    assert.equal(JSON.stringify(started).includes(bi.identityToken),false);
    assert.equal(JSON.stringify(started).includes(ci.identityToken),false);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/debug/room/${roomId}`)).status,404);
    listed=await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json();assert.equal(listed.rooms[0].status,'playing');
    await identify(duplicate,'Mallory');
    duplicate.send('join_room',{roomId,resumeToken:created.resumeToken});assert.equal((await duplicate.wait('error')).code,'GAME_STARTED');
    a.send('create_room',{game:'doudizhu'});assert.equal((await a.wait('error')).code,'ACTIVE_ROOM');
    a.send('game_restart',{});assert.equal((await a.wait('error')).code,'GAME_IN_PROGRESS');
    a.send('dissolve_vote',{agree:true});assert.equal((await a.wait('error')).code,'DISSOLVE_UNAVAILABLE');
    c.ws.close();await sleep(180);
    listed=await(await fetch(`http://127.0.0.1:${port}/api/rooms`)).json();
    assert.equal(listed.rooms[0].seats[2].online,false);assert.equal(listed.rooms[0].seats[2].vacant,false);
    assert.equal(listed.rooms[0].seats[2].name,ci.name);

    a.send('dissolve_vote',{agree:true});const vote=await a.wait('room_update',m=>m.dissolution?.votes?.length===1);assert.equal(vote.dissolution.eligible,true);
    const c2=await client();await identify(c2,null,ci.identityToken);c2.send('join_room',{roomId});const resumed=await c2.wait('room_joined');
    assert.equal(resumed.playerIndex,2);assert.deepEqual(resumed.dissolution.votes,[]);assert.deepEqual(resumed.state.hands[2],JSON.parse(fs.readFileSync(stateFile)).rooms[0].state.hands[2]);
    // Saved state survives a process restart without re-dealing or disclosing identity tokens.
    await stop();await start();
    const a2=await client(),b2=await client();const recovered=await identify(a2,null,ai.identityToken);assert.equal(recovered.roomId,roomId);
    a2.send('join_room',{roomId});const ar=await a2.wait('room_joined');assert.deepEqual(ar.state.hands[0],started.state.hands[0]);
    await identify(b2,null,bi.identityToken);b2.send('join_room',{roomId});await b2.wait('room_joined');
    await sleep(180);a2.send('dissolve_vote',{agree:true});await a2.wait('room_update',m=>m.dissolution?.votes?.length===1);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json()).rooms.length,1);
    b2.send('dissolve_vote',{agree:true});const done=await a2.wait('room_dissolved');assert.equal(done.reason,'offline_vote');assert.deepEqual(done.scores,[0,0,0]);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json()).rooms.length,0);
    assert.equal(fs.statSync(stateFile).mode & 0o777,0o600);
  } finally {for(const c of clients)c.ws.terminate();await stop();fs.rmSync(dir,{recursive:true,force:true});}
});

// Covers identity replacement, explicit leave vs disconnect, and seat data persistence.
test('single-login tokens, private identity directory, paused vacancies and exact seat inheritance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamenest-seats-'));
  const stateFile = path.join(dir, 'state.json');
  const port = 31000 + (process.pid % 10000);
  let child; const clients = [];
  async function start() {
    child = spawn(process.execPath, ['server.js'], {cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',GAMENEST_STATE_FILE:stateFile,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
    let log=''; child.stderr.on('data',b=>log+=b);
    for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/rooms`)).ok)return;}catch{}await sleep(30)}throw Error(log);
  }
  async function stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}
  async function connect() {
    const ws=new WebSocket(`ws://127.0.0.1:${port}`), messages=[];
    ws.on('message',b=>messages.push(JSON.parse(b)));
    await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
    const c={ws,messages,send(type,data={}){ws.send(JSON.stringify({type,data}));},async wait(type,p=()=>true){for(let i=0;i<100;i++){const n=messages.findIndex(m=>m.type===type&&p(m));if(n>=0)return messages.splice(n,1)[0];await sleep(20)}throw Error(`Timeout ${type} `+JSON.stringify(messages));}};
    clients.push(c);return c;
  }
  async function login(c,data){c.send('identify',data);return c.wait('identified');}
  try {
    await start();
    const a=await connect(), b=await connect(), c=await connect();
    const first=await login(a,{name:'Ａlice'}), bi=await login(b,{name:'Bob'}), ci=await login(c,{name:'Carol'});
    a.send('create_room',{game:'doudizhu',options:{bidMode:'score',totalRounds:3}});
    const room=await a.wait('room_created'), roomId=room.roomId;
    b.send('join_room',{roomId});await b.wait('room_joined');c.send('join_room',{roomId});await c.wait('room_joined');
    for(const player of [a,b,c])player.send('player_ready');await sleep(30);a.send('start_game');
    const started=await a.wait('game_started');await b.wait('game_started');await c.wait('game_started');
    const next=await connect(), replacement=await login(next,{name:' alice '});
    assert.equal(replacement.name,'Alice');assert.notEqual(replacement.identityToken,first.identityToken);
    await a.wait('session_replaced');
    const stale=await connect();stale.send('identify',{identityToken:first.identityToken});
    assert.equal((await stale.wait('error')).code,'IDENTITY_INVALID');
    const usersResponse=await fetch(`http://127.0.0.1:${port}/api/users`);
    assert.equal(usersResponse.status,404);
    assert.deepEqual(await usersResponse.json(),{error:'not_found'});
    assert.equal(usersResponse.headers.get('cache-control'),'no-store');
    next.send('join_room',{roomId});const rejoined=await next.wait('room_joined');
    assert.equal(rejoined.playerIndex,0);assert.deepEqual(rejoined.state.hands[0],started.state.hands[0]);
    assert.equal(rejoined.state.paused,false);
    const occupiedResponse=await fetch(`http://127.0.0.1:${port}/api/rooms`);
    assert.equal(occupiedResponse.headers.get('cache-control'),'no-store');
    const occupied=(await occupiedResponse.json()).rooms.find(r=>r.roomId===roomId);
    assert.deepEqual(occupied.seats,[{index:0,name:'Alice',vacant:false,online:true},{index:1,name:'Bob',vacant:false,online:true},{index:2,name:'Carol',vacant:false,online:true}]);
    assert.ok(occupied.seats.every(s=>Object.keys(s).sort().join(',')==='index,name,online,vacant'));
    assert.ok(!JSON.stringify(occupied).includes(replacement.identityToken));

    const seated=[next,b,c];
    // Make the current actor the landlord, then leave that exact seat.
    const actor=started.state.currentPlayer;
    seated[actor].send('game_move',{action:'bid',score:3});
    const playing=await next.wait('game_state',m=>m.state.phase==='playing');
    assert.equal(playing.state.landlord,actor);
    const before=JSON.parse(fs.readFileSync(stateFile)).rooms.find(r=>r.id===roomId).state;
    seated[actor].send('leave_room');await seated[actor].wait('left_room');
    const witness=seated[(actor+1)%3];
    const paused=await witness.wait('game_state',m=>m.state.paused && m.state.phase==='playing');
    assert.equal(paused.state.board.paused,true);assert.equal(paused.yourTurn,false);
    assert.equal(paused.players.find(p=>p.index===actor).vacant,true);
    witness.send('game_move',{action:'pass'});assert.equal((await witness.wait('error')).code,'GAME_PAUSED');
    let list=await(await fetch(`http://127.0.0.1:${port}/api/rooms`)).json();
    const vacancy=list.rooms.find(r=>r.roomId===roomId);assert.equal(vacancy.canJoin,true);assert.equal(vacancy.playerCount,2);assert.equal(vacancy.status,'paused');
    assert.deepEqual(vacancy.seats[actor],{index:actor,name:'',vacant:true,online:false});
    // The leaving identity is no longer tied to the table and may create a different room.
    seated[actor].send('create_room',{game:'doudizhu'});const other=await seated[actor].wait('room_created');assert.notEqual(other.roomId,roomId);
    const d=await connect();await login(d,{name:'Replacement'});d.send('join_room',{roomId});const inherited=await d.wait('room_joined');
    assert.equal(inherited.playerIndex,actor);assert.deepEqual(inherited.state.hands[actor],before.hands[actor]);
    assert.equal(inherited.state.landlord,actor);assert.equal(inherited.state.currentPlayer,actor);
    assert.deepEqual(inherited.state.cumulativeScore,before.cumulativeScore);assert.equal(inherited.state.multiplier,before.multiplier);
    const filled=(await(await fetch(`http://127.0.0.1:${port}/api/rooms`)).json()).rooms.find(r=>r.roomId===roomId);
    assert.deepEqual(filled.seats[actor],{index:actor,name:'Replacement',vacant:false,online:true});
    assert.equal(inherited.state.paused,false);assert.ok(inherited.state.hands[(actor+1)%3].every(x=>x===null));
    const card=before.hands[actor][0];d.send('game_move',{action:'play',cards:[card.id]});
    const moved=await d.wait('game_state',m=>m.state.hands[actor].length===before.hands[actor].length-1);assert.equal(moved.state.paused,false);
    // Explicitly vacating the final seat removes even an unfinished table.
    for(const player of [d,...seated.filter((_,i)=>i!==actor)]){player.send('leave_room');await player.wait('left_room');}
    list=await(await fetch(`http://127.0.0.1:${port}/api/rooms`)).json();assert.equal(list.rooms.some(r=>r.roomId===roomId),false);
    assert.equal(JSON.parse(fs.readFileSync(stateFile)).rooms.some(r=>r.id===roomId),false);
    await stop();await start();
    const e=await connect();await login(e,{name:'New arrival'});e.send('join_room',{roomId});assert.equal((await e.wait('error')).code,'ROOM_NOT_FOUND');
    const savedToken=replacement.identityToken;
    const loginAgain=await connect();await login(loginAgain,{identityToken:savedToken});
    const oldRefresh=await connect();oldRefresh.send('identify',{identityToken:savedToken});assert.equal((await oldRefresh.wait('error')).code,'IDENTITY_INVALID');
  } finally {for(const c of clients)c.ws.terminate();await stop();fs.rmSync(dir,{recursive:true,force:true});}
});
