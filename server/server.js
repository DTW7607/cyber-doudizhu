'use strict';
// GameNest landlord service. Apache-2.0; see LICENSE and NOTICE.
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const compression = require('compression');
const QRCode = require('qrcode');
const { Tables } = require('./runtime/tables');
const { getNextPort } = require('./startup-port');
const release = require('./package.json').version;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16384 });
let stopping = false;
let activePort = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const tables = new Tables(process.env.GAMENEST_STATE_FILE || path.join(__dirname,'data/state.json'),wss.clients,()=>shutdown(1));

app.disable('x-powered-by');
app.use(compression({threshold:512}));
app.use((req,res,next)=>{res.set('X-Content-Type-Options','nosniff');next();});
app.get('/api/health', (req,res)=>res.status(tables.failed || stopping ? 503 : 200).set('Cache-Control','no-store').json({ok:!tables.failed && !stopping,release}));
app.get('/api/users', (req,res)=>res.status(404).set('Cache-Control','no-store').json({error:'not_found'}));
app.use('/api/debug',(req,res)=>res.status(404).json({error:'not_found'}));
app.get('/api/rooms',(req,res)=>res.set('Cache-Control','no-store').json({rooms:tables.list()}));
app.get('/api/room-exists/:roomId',(req,res)=>res.set('Cache-Control','no-store').json({exists:tables.rooms.has(req.params.roomId.toUpperCase())}));
function shareUrl(req) {
  const room=typeof req.query.room==='string'?req.query.room.trim().toUpperCase():'';
  if(!/^[A-Z0-9]{1,8}$/.test(room))return null;
  const host=/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(req.get('host')||'')?req.get('host'):'localhost:'+activePort;
  return `${req.protocol}://${host}/?room=${encodeURIComponent(room)}`;
}
app.get('/api/share-url',(req,res)=>{const url=shareUrl(req);if(!url)return res.status(400).json({error:'missing room'});res.json({url});});
app.get('/qr',async(req,res)=>{
  const url=shareUrl(req);if(!url)return res.status(400).send('missing room');
  try{res.type('png').send(await QRCode.toBuffer(url,{width:256,margin:2}));}catch(_){res.status(500).send('qr unavailable');}
});
app.get('/game.html',(req,res)=>res.redirect('/'));
app.use(express.static(path.join(__dirname,'public'),{setHeaders:res=>res.set('Cache-Control','no-cache')}));
app.use((req,res)=>res.status(404).json({error:'not_found'}));

wss.on('connection',ws=>{
  if(stopping){ws.close(1012,'service restarting');return;}
  ws.alive=true;ws.on('pong',()=>{ws.alive=true;});ws.on('error',()=>{});
  let tokens=40,last=Date.now(),dropped=0;
  ws.on('message',raw=>{
    if(stopping)return;
    const now=Date.now();tokens=Math.min(40,tokens+(now-last)*0.01);last=now;
    if(tokens<1){if(++dropped>40)ws.close(1008,'rate limit');return;}tokens--;dropped=0;
    let msg;try{msg=JSON.parse(raw.toString());}catch(_){return;}
    tables.dispatch(ws,msg);
  });
  ws.on('close',()=>tables.disconnect(ws));
});
wss.on('error',e=>console.error('[websocket]',e.message));
const heartbeat=setInterval(()=>{
  for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;try{ws.ping();}catch(_){}}
},15000);
heartbeat.unref();
const presence=setInterval(()=>{
  for(const room of tables.rooms.values()){
    const eligible=tables.dissolution(room).eligible;
    if(eligible!==room.lastEligible){room.lastEligible=eligible;tables.broadcast(room);}
  }
},5000);
presence.unref();
function shutdown(code=0){
  if(stopping)return;stopping=true;clearInterval(heartbeat);clearInterval(presence);
  server.close(()=>process.exit(code));
  for(const ws of wss.clients)try{ws.close(1012,'service restarting');}catch(_){}
  setTimeout(()=>{for(const ws of wss.clients)ws.terminate();process.exit(code);},1500).unref();
}
process.on('SIGTERM',()=>shutdown());process.on('SIGINT',()=>shutdown());
function start(port,attempt=0){
  const onError=e=>{
    const next=getNextPort(e.code,port);
    if(!('PORT' in process.env) && next && attempt<5)return start(next,attempt+1);
    console.error('[startup]',e.message);process.exit(1);
  };
  server.once('error',onError);
  server.listen(port,process.env.HOST || '127.0.0.1',()=>{server.off('error',onError);activePort=server.address().port;console.log(`GameNest 斗地主 ${release} listening on port ${activePort}`);});
}
start(activePort);
module.exports={server,getActivePort:()=>activePort};
