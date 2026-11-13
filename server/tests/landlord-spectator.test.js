'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {service,sleep}=require('./helpers/service');
const {Tables}=require('../runtime/tables');
const game=require('../games/doudizhu');
async function setup(s){
 const players=[];
 for(const name of ['Watch-A','Watch-B','Watch-C']){const p=await s.client();await p.call('identify',{name});players.push(p);}
 await players[0].call('create_room',{game:'doudizhu',options:{totalRounds:1}});const room=await players[0].wait('room_created');
 for(const p of players.slice(1))await p.call('join_room',{roomId:room.roomId});
 return {players,room};
}
function hidden(m){
 assert.equal(m.spectator,true);assert.equal(m.playerIndex,-1);assert.equal(m.yourTurn,false);
 if(m.state){assert.ok(m.state.hands.every(h=>h.every(c=>c===null)));assert.equal(m.state.board,undefined);}
 assert.equal(m.identityToken,undefined);assert.equal(m.resumeToken,undefined);
 assert.ok(m.players.every(p=>!('identityId' in p)&&!('resumeToken' in p)));
}
test('anonymous spectators see public updates without seats, tokens, checkpoint writes or player permissions',async()=>{
 const s=await service();try{
  const {players,room}=await setup(s),w=await s.client(),before=s.snapshot(),mtime=fs.statSync(s.file).mtimeMs;
  assert.equal((await w.call('watch_room',{roomId:room.roomId,playerIndex:0})).ok,true);hidden(await w.wait('room_watched'));
  assert.deepEqual(s.snapshot(),before);assert.equal(fs.statSync(s.file).mtimeMs,mtime);
  for(const type of ['identify','join_room','create_room','game_move','player_ready','start_game','set_name','set_option','set_private','dissolve_vote','game_restart','return_to_room','logout']){
   assert.equal((await w.call(type,{name:'Watch-A',roomId:room.roomId,game:'doudizhu',score:3,agree:true})).code,'SPECTATOR_READ_ONLY');
  }
  assert.deepEqual(s.snapshot(),before);
  for(const p of players)await p.call('player_ready',{ready:true});await players[0].call('start_game');
  const started=await w.wait('game_started');hidden(started);assert.ok(started.state.bottomCards.every(c=>c===null));
  const actor=started.state.currentPlayer;await players[actor].call('game_move',{score:3});
  const playing=await w.wait('game_state',m=>m.state.phase==='playing');hidden(playing);assert.equal(playing.state.bottomCards.filter(Boolean).length,3);
  const card=s.snapshot().rooms[0].state.hands[actor][0];await players[actor].call('game_move',{cards:[card.id]});
  const moved=await w.wait('game_state',m=>m.state.lastPlay);hidden(moved);assert.deepEqual(moved.state.lastPlay.cards,[card]);
  assert.equal((await players[actor].call('watch_room',{roomId:room.roomId})).code,'ACTIVE_ROOM');
  const stable=s.snapshot();await w.call('get_state');hidden(await w.wait('room_watched'));await w.call('leave_room');await w.wait('left_room');
  assert.deepEqual(s.snapshot(),stable);assert.equal((await w.call('game_move',{cards:[]})).code,'IDENTITY_REQUIRED');
  await w.call('watch_room',{roomId:room.roomId});await w.wait('room_watched');w.ws.close();await sleep(50);assert.deepEqual(s.snapshot(),stable);
  await s.stop();await s.start();const rewatch=await s.client();await rewatch.call('watch_room',{roomId:room.roomId});hidden(await rewatch.wait('room_watched'));
  assert.deepEqual(s.snapshot().rooms[0].state,stable.rooms[0].state);
 }finally{await s.close();}
});
test('spectator projection hides all hands at bidding, play, round settlement and final settlement',()=>{
 const state=game.createState();state._options={totalRounds:1};game.initGame(state,3);
 const tables=Object.create(Tables.prototype),room={state,phase:'playing',revision:7,players:new Map()};
 for(const phase of ['bidding','playing','roundEnd','over']){
  state.phase=phase;state.winner=phase==='over'?-2:null;state.internalSecret={cards:state.hands};
  const original=JSON.stringify(state),view=tables.spectatorView(room);
  assert.ok(view.hands.every(h=>h.every(c=>c===null)));assert.equal(view.internalSecret,undefined);assert.equal(view.board,undefined);
  assert.equal(JSON.stringify(state),original);
  if(phase==='bidding')assert.ok(view.bottomCards.every(c=>c===null));
 }
 room.phase='lobby';assert.equal(tables.spectatorView(room),null);
});
test('watchers follow lobby removal and offline-vote dissolution; private rooms stay unlisted',async()=>{
 const s=await service();try{
  const a=await s.client();await a.call('identify',{name:'Owner'});await a.call('create_room',{game:'doudizhu'});const room=await a.wait('room_created');
  await a.call('set_private',{isPrivate:true});assert.equal((await(await fetch(s.origin+'/api/rooms')).json()).rooms.length,0);
  const w=await s.client();assert.equal((await w.call('watch_room',{roomId:'MISSING'})).code,'ROOM_NOT_FOUND');
  await w.call('watch_room',{roomId:room.roomId});hidden(await w.wait('room_watched'));await a.call('leave_room');await w.wait('room_dissolved');
  const {players,room:next}=await setup(s);await w.call('watch_room',{roomId:next.roomId});await w.wait('room_watched');
  players[2].ws.close();await w.wait('player_left',m=>m.players.some(p=>p.index===2 && !p.online));await sleep(160);assert.equal((await players[0].call('dissolve_vote',{agree:true})).ok,true);assert.equal((await players[1].call('dissolve_vote',{agree:true})).ok,true);await w.wait('room_dissolved');
  assert.equal(s.snapshot().rooms.length,0);
 }finally{await s.close();}
});
