'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom'),WS=require('ws');
const {service,sleep}=require('./helpers/service');
async function until(fn){for(let i=0;i<150;i++){if(fn())return;await sleep(20);}assert.ok(fn(),'UI update timed out');}
test('spectator page renders three hidden hands, public cards, scores and reconnects without identity',async()=>{
 const s=await service(),sockets=[],errors=[];let dom;
 try{
  const players=[];for(const name of ['UI-A','UI-B','UI-C']){const c=await s.client();await c.call('identify',{name});players.push(c);}
  await players[0].call('create_room',{game:'doudizhu'});const room=await players[0].wait('room_created');for(const p of players.slice(1))await p.call('join_room',{roomId:room.roomId});
  const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  dom=new JSDOM(fs.readFileSync(path.resolve('public/watch.html'),'utf8'),{url:s.origin+'/watch.html?room='+room.roomId,runScripts:'outside-only',virtualConsole:vc});const w=dom.window;
  w.WebSocket=class extends WS{constructor(...args){super(...args);sockets.push(this);}};w.fetch=(u,o)=>fetch(new URL(u,w.location.href),o);
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.requestAnimationFrame=fn=>w.setTimeout(fn,16);
  for(const script of w.document.querySelectorAll('script[src]'))w.eval(fs.readFileSync(path.resolve('public'+script.getAttribute('src')),'utf8'));
  await until(()=>w.document.querySelectorAll('.gn-wait-seat').length===3);assert.equal(w.document.getElementById('watchWaiting').hidden,false);
  for(const p of players)await p.call('player_ready',{ready:true});await players[0].call('start_game');await until(()=>w.document.querySelectorAll('#ddzHand .pc-back').length===17);assert.equal(w.document.querySelectorAll('#ddzOpponents .ddz-seat').length,2);assert.ok(w.document.getElementById('ddzSelfSeat'));assert.equal(w.document.querySelectorAll('#ddzHand [data-id]').length,0);
  assert.equal(w.document.querySelectorAll('#ddzActions button,#ddzVotePanel button').length,0);assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);
  const state=s.snapshot().rooms[0].state;await players[state.currentPlayer].call('game_move',{score:3});const card=s.snapshot().rooms[0].state.hands[state.currentPlayer][0];await players[state.currentPlayer].call('game_move',{cards:[card.id]});
  await until(()=>w.document.querySelectorAll('.ddz-last-play .pc-card').length===1);assert.match(w.document.querySelector('.ddz-last-play').textContent,new RegExp(card.rank));
  for(let i=0;i<3;i++){w.document.getElementById('watchSeat').value=String(i);w.document.getElementById('watchSeat').dispatchEvent(new w.Event('change'));assert.equal(w.document.querySelectorAll('#ddzHand .pc-back').length,s.snapshot().rooms[0].state.hands[i].length);assert.equal(w.document.querySelectorAll('#ddzHand [data-id],#ddzHand button,#ddzActions button,#ddzVotePanel button').length,0);}
  sockets[0].close();await until(()=>sockets.length===2 && /已连接/.test(w.document.getElementById('watchStatus').textContent));
  assert.equal(s.snapshot().identities.length,3);assert.equal(s.snapshot().rooms[0].players.length,3);assert.deepEqual(errors,[]);
 }finally{if(dom){dom.window.GNDisposeWatch();dom.window.close();}for(const ws of sockets)ws.terminate();await s.close();}
});
