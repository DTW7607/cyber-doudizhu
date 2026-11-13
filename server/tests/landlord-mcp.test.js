// Modified 2026-11-12: local ordinary-player MCP integration.
const test=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const req=require('node:module').createRequire(path.resolve('mcp/package.json'));
const {Client}=req('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=req('@modelcontextprotocol/sdk/client/stdio.js');
test('MCP ordinary player tools, identity, room and no hidden information',{timeout:60000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ddz-mcp-')); const port=19532;
 const server=spawn(process.execPath,['server.js'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),GAMENEST_STATE_FILE:path.join(dir,'state.json')},stdio:'ignore'}); const clients=[];
 try {
  for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/rooms`)).ok)break}catch{} await new Promise(r=>setTimeout(r,100))}
  async function client(){const c=new Client({name:'test',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:['mcp/server.js'],env:{...process.env,GAMENEST_URL:`ws://127.0.0.1:${port}`},stderr:'pipe'}));clients.push(c);return c}
  async function call(c,name,args={}){const r=await c.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text)}
  const a=await client();const names=(await a.listTools()).tools.map(t=>t.name);for(const n of ['suggest_move','add_bot','get_canvas','draw'])assert.ok(!names.includes(n));
  const games=await call(a,'list_games');assert.deepEqual(games.map(x=>x.id),['doudizhu']);
  const room=await call(a,'create_room',{game:'doudizhu',name:'MCP-A'});assert.ok(room.roomId);assert.ok(!JSON.stringify(room).includes('identityToken'));
  const b=await client(),c=await client();await call(b,'join_room',{roomId:room.roomId,name:'MCP-B'});await call(c,'join_room',{roomId:room.roomId,name:'MCP-C'});
  const list=await call(a,'list_rooms');assert.equal(list.rooms[0].playerCount,3);assert.equal(list.rooms[0].canJoin,false);
  for(const x of clients)await call(x,'ready');await call(a,'start_game');
  for(const x of clients){const snap=await call(x,'get_state');assert.equal(snap.state.hands[snap.mySeat].length,17);snap.state.hands.forEach((hand,i)=>{if(i!==snap.mySeat)assert.ok(hand.every(v=>v===null))});}
  // A replacement login invalidates the old process rather than auto-resuming it.
  const before=await call(a,'get_state'); const replacement=await client();
  await call(replacement,'identify',{name:'MCP-A'});
  await new Promise(r=>setTimeout(r,100));
  const kicked=await call(a,'get_state');assert.equal(kicked.sessionReplaced,true);assert.equal(kicked.roomId,null);
  const retry=await a.callTool({name:'identify',arguments:{}});assert.equal(retry.isError,true);
  await call(replacement,'join_room',{roomId:room.roomId});
  await call(replacement,'leave_room');
  const paused=await call(b,'get_state');assert.equal(paused.paused,true);assert.equal(paused.isMyTurn,false);
  const newcomer=await client();const inherited=await call(newcomer,'join_room',{roomId:room.roomId,name:'MCP-D'});
  assert.equal(inherited.mySeat,0);
  const newState=await call(newcomer,'get_state');assert.deepEqual(newState.state.hands[0],before.state.hands[0]);
  assert.equal(newState.paused,false);

 }finally{for(const c of clients)await c.close();server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});

test('MCP does not report success for unrelated broadcasts without a request acknowledgement',{timeout:10000},async()=>{
 const {WebSocketServer}=require('ws'),wss=new WebSocketServer({host:'127.0.0.1',port:0});
 await new Promise(r=>wss.once('listening',r));
 wss.on('connection',ws=>ws.on('message',raw=>{
  const m=JSON.parse(raw);
  if(m.type==='create_room'){
   ws.send(JSON.stringify({type:'room_created',roomId:'TEST',game:'doudizhu',playerIndex:0,identityToken:'fake-test-token',phase:'lobby',players:[{index:0,isHost:true}],options:{}}));
   ws.send(JSON.stringify({type:'action_result',requestId:m.requestId,ok:true}));
  }else ws.send(JSON.stringify({type:'room_update',phase:'lobby',players:[{index:0,isHost:true}]}));
 }));
 const c=new Client({name:'timeout-test',version:'1'});
 try{
  await c.connect(new StdioClientTransport({command:process.execPath,args:['mcp/server.js'],env:{...process.env,GAMENEST_URL:`ws://127.0.0.1:${wss.address().port}`},stderr:'pipe'}));
  assert.ok(!(await c.callTool({name:'create_room',arguments:{game:'doudizhu',name:'test'}})).isError);
  const result=await c.callTool({name:'send_message',arguments:{type:'set_avatar',data:{avatar:'😊'}}});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/No server acknowledgement/);
 }finally{await c.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));}
});
