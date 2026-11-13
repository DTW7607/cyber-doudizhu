'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const WS=require('ws');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function service(options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ddz-audit-')),file=path.join(dir,'state.json');
 if(options.snapshot)fs.writeFileSync(file,JSON.stringify(options.snapshot),{mode:0o600});
 let child,origin,log='';const clients=[];
 async function start(){
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,HOST:'127.0.0.1',PORT:'0',GAMENEST_STATE_FILE:file,NODE_ENV:'test',TEST_OFFLINE_VOTE_MS:'80'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>log+=b);
  for(let i=0;i<750;i++){const m=output.match(/listening on port (\d+)/);if(m){origin='http://127.0.0.1:'+m[1];return;}if(child.exitCode!==null)throw Error(log);await sleep(20);}throw Error('startup timeout '+log);
 }
 async function stop(){if(child?.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exit;}}
 async function client(){
  const ws=new WS(origin.replace('http:','ws:')),messages=[];
  ws.on('message',raw=>messages.push(JSON.parse(raw)));ws.on('error',()=>{});
  await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
  const c={ws,messages,send(type,data={},requestId){ws.send(JSON.stringify({type,data,requestId}));},async wait(type,p=()=>true){for(let i=0;i<750;i++){const n=messages.findIndex(m=>m.type===type&&p(m));if(n>=0)return messages.splice(n,1)[0];await sleep(10);}throw Error('timeout '+type+'; seen '+messages.map(m=>m.type+':'+(m.code||'')).join(','));},async call(type,data={},id){id ||= 'test-'+Math.random().toString(36).slice(2);c.send(type,data,id);return c.wait('action_result',m=>m.requestId===id);}};
  clients.push(c);return c;
 }
 await start();
 return {dir,file,get origin(){return origin;},client,start,stop,get log(){return log;},snapshot:()=>JSON.parse(fs.readFileSync(file)),async close(){for(const c of clients)c.ws.terminate();await stop();fs.rmSync(dir,{recursive:true,force:true});}};
}
module.exports={service,sleep};
