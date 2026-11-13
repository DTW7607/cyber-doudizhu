'use strict';
// Read a private v1 checkpoint; all mutation occurs in a disposable copy.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {service}=require('../tests/helpers/service');
const {validate}=require('../runtime/state-store');
(async()=>{
 const source=process.argv[2];if(!source)throw Error('Usage: node scripts/verify-migration.js /private/state.json');
 const bytes=fs.readFileSync(source),original=validate(JSON.parse(bytes)),s=await service({snapshot:original});
 try{
  for(const savedRoom of original.rooms){
   for(const player of savedRoom.players){
    const token=original.identities.find(([,u])=>u.id===player.identityId)[0],client=await s.client();
    assert.equal((await client.call('identify',{identityToken:token})).ok,true);await client.wait('identified');
    assert.equal((await client.call('join_room',{roomId:savedRoom.id})).ok,true);
    const joined=await client.wait('room_joined');assert.equal(joined.playerIndex,player.index);
    if(savedRoom.state){assert.deepEqual(joined.state.hands[player.index],savedRoom.state.hands[player.index]);assert.deepEqual(joined.state.cumulativeScore,savedRoom.state.cumulativeScore);assert.deepEqual(joined.state.roundHistory,savedRoom.state.roundHistory);}
   }
   assert.deepEqual(s.snapshot().rooms.find(r=>r.id===savedRoom.id).state,savedRoom.state);
  }
  const identities=original.identities.map(([,u])=>u).sort((a,b)=>a.id.localeCompare(b.id));
  assert.deepEqual(s.snapshot().identities.map(([,u])=>u).sort((a,b)=>a.id.localeCompare(b.id)),identities);
  await s.stop();await s.start();
  for(const r of original.rooms)assert.deepEqual(s.snapshot().rooms.find(x=>x.id===r.id).state,r.state);
  assert.ok(fs.readFileSync(source).equals(bytes));
  console.log(JSON.stringify({ok:true,version:original.version,identities:identities.length,rooms:original.rooms.length,checks:['original untouched','each occupied seat resumed','all hands, scores, history and turn unchanged','restart preserved game state']}));
 }finally{await s.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
