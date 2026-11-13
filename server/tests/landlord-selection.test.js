const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
function fixture(){
 const d=new JSDOM('<html><head></head><body><div id="root"></div></body></html>',{url:'http://localhost',runScripts:'outside-only'}),w=d.window;
 w._t=k=>k;w._tf=(k,v)=>k+v;w.showToast=()=>{};w.escHtml=s=>String(s).replace(/[&<>"']/g,'');w.gamePlayers=[{name:'A'},{name:'B'},{name:'C'}];w.sessionStorage.setItem('playerIndex','0');w.moves=[];w.makeGameMove=m=>w.moves.push(m);w.requestAnimationFrame=()=>{};
 for(const f of ['public/js/ui/cards.js','public/js/renderers/doudizhu.js'])w.eval(fs.readFileSync(path.join(__dirname,'..',f),'utf8'));
 const r=w.gameRenderers.get('doudizhu'),root=w.document.getElementById('root');r.init(root);
 const s={phase:'playing',currentRound:1,totalRounds:3,currentPlayer:1,landlord:0,gameMultiplier:1,hands:[[{id:'3s',rank:'3',suit:'s'},{id:'Kh',rank:'K',suit:'h'},{id:'Ks',rank:'K',suit:'s'},{id:'BJ',rank:'大王'},{id:'2s',rank:'2',suit:'s'}],Array(17).fill(null),Array(17).fill(null)],bottomCards:[],cumulativeScore:[0,0,0]};
 const draw=()=>{w._ddzState=s;r.render(s,root,0,null)};draw();
 return {d,w,r,s,draw,hand:w.document.getElementById('ddzHand'),selected:()=>Array.from(w.document.querySelectorAll('.ddz-card.is-selected'),e=>e.dataset.id)};
}
function pointer(w,target,type,x,y,props={}){const e=new w.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{pointerId:1,isPrimary:true,button:0,clientX:x,clientY:y},props);target.dispatchEvent(e);}
function rects(f){Array.from(f.hand.querySelectorAll('.ddz-card')).forEach((c,i)=>{c.getBoundingClientRect=()=>({left:10+i*30,right:70+i*30,top:100,bottom:180,width:60,height:80})});}
test('descending hand, off-turn preselection, retained across turns, local turn guard and accepted-card pruning',()=>{
 const f=fixture();try{assert.deepEqual(Array.from(f.hand.querySelectorAll('.ddz-card'),x=>x.dataset.id),['BJ','2s','Kh','Ks','3s']);
 f.w._ddzToggleCard('Kh');f.w._ddzToggleCard('Ks');assert.deepEqual(f.selected().sort(),['Kh','Ks']);f.w._ddzPlay();assert.equal(f.w.moves.length,0);
 f.s.currentPlayer=0;f.draw();assert.deepEqual(f.selected().sort(),['Kh','Ks']);f.w._ddzPlay();assert.deepEqual(Array.from(f.w.moves[0].cards).sort(),['Kh','Ks']);
 // A rejected/unacknowledged move keeps the editable selection.
 f.draw();assert.equal(f.selected().length,2);f.s.hands[0]=f.s.hands[0].filter(x=>x.id!=='Kh');f.draw();assert.deepEqual(f.selected(),['Ks']);
 f.s.currentRound=2;f.draw();assert.equal(f.selected().length,0);
 }finally{f.d.window.close()}
});
test('pointer drag selects crossed ranks once, synthetic click does not invert, reverse drag deselects and cancel ends gesture',()=>{
 const f=fixture();try{rects(f);let cards=f.hand.querySelectorAll('.ddz-card');pointer(f.w,cards[0],'pointerdown',15,130);pointer(f.w,f.hand,'pointermove',105,130);pointer(f.w,f.hand,'pointermove',15,130);pointer(f.w,f.hand,'pointerup',15,130);cards[0].dispatchEvent(new f.w.MouseEvent('click',{bubbles:true}));assert.equal(f.selected().length,4);
 pointer(f.w,cards[0],'pointerdown',15,130);pointer(f.w,f.hand,'pointermove',105,130);pointer(f.w,f.hand,'pointercancel',105,130);assert.equal(f.selected().length,0);pointer(f.w,f.hand,'pointermove',150,130);assert.equal(f.selected().length,0);
 // Keyboard works independently of recent pointer click suppression.
 cards[2].dispatchEvent(new f.w.KeyboardEvent('keydown',{key:' ',bubbles:true}));assert.deepEqual(f.selected(),['Kh']);assert.equal(cards[2].getAttribute('aria-pressed'),'true');
 }finally{f.d.window.close()}
});
test('new round and ended phase stop editing; 20-card hand uses bounded responsive overlap',()=>{
 const f=fixture();try{f.s.hands[0]=Array.from({length:20},(_,i)=>({id:'x'+i,rank:'3',suit:'s'}));Object.defineProperty(f.hand,'clientWidth',{value:620});f.draw();
 const g=f.hand.querySelector('.pc-layout-hand');assert.ok(parseFloat(g.style.getPropertyValue('--ddz-step'))>=20);assert.ok(parseFloat(g.style.getPropertyValue('--ddz-hand-width'))<=620);
 f.s.phase='roundEnd';f.draw();f.w._ddzToggleCard('x1');assert.equal(f.selected().length,0);assert.equal(f.hand.querySelector('.ddz-card').getAttribute('aria-disabled'),'true');
 }finally{f.d.window.close()}
});
test('touch primary drag works, non-primary contact is ignored, busy play cannot send twice',()=>{
 const f=fixture();try{rects(f);const cards=f.hand.querySelectorAll('.ddz-card');
 pointer(f.w,cards[0],'pointerdown',15,130,{pointerType:'touch',isPrimary:false,pointerId:2});
 pointer(f.w,f.hand,'pointermove',105,130,{pointerType:'touch',isPrimary:false,pointerId:2});
 pointer(f.w,f.hand,'pointerup',105,130,{pointerType:'touch',isPrimary:false,pointerId:2});
 assert.equal(f.selected().length,0,'secondary finger must not start a selection');
 pointer(f.w,cards[0],'pointerdown',15,130,{pointerType:'touch'});
 pointer(f.w,f.hand,'pointermove',75,130,{pointerType:'touch'});
 assert.equal(f.selected().length,3);
 pointer(f.w,cards[4],'pointerdown',135,130,{pointerType:'touch',isPrimary:false,pointerId:2});
 pointer(f.w,f.hand,'pointermove',150,130,{pointerType:'touch',isPrimary:false,pointerId:2});
 assert.equal(f.selected().length,3,'secondary contact cannot replace the primary gesture');
 pointer(f.w,f.hand,'pointerup',75,130,{pointerType:'touch'});
 f.s.currentPlayer=0;f.draw();f.w._gnMoveBusy=true;f.w._ddzPlay();assert.equal(f.w.moves.length,0);
 f.w._gnMoveBusy=false;f.w._ddzPlay();assert.equal(f.w.moves.length,1);
 f.w._gnMoveBusy=true;f.w._ddzPlay();assert.equal(f.w.moves.length,1,'pending move rejects repeat send');
 }finally{f.d.window.close()}
});

test('paused table keeps editable cards but cannot play; opponent scores and turn clock are explicit',()=>{
 const f=fixture();try{f.s.cumulativeScore=[4,-7,3];f.draw();assert.deepEqual(Array.from(f.w.document.querySelectorAll('.ddz-seat-score b'),x=>x.textContent),['-7','3']);assert.equal(f.w.document.querySelector('.ddz-turn-clock').dataset.playerIndex,'1');
 f.s.currentPlayer=0;f.s.paused=true;f.draw();f.w._ddzToggleCard('Kh');f.w._ddzPlay();f.w._ddzPass();assert.equal(f.w.moves.length,0);assert.ok(f.w.document.querySelector('.ddz-pause-banner'));assert.equal(f.w.document.querySelector('.ddz-turn-clock'),null);
 }finally{f.d.window.close()}
});
test('kicked tab refresh cannot borrow new shared identity or delete its token',()=>{
 const d=new JSDOM('',{url:'http://localhost',runScripts:'outside-only'}),w=d.window,code=fs.readFileSync(path.join(__dirname,'../public/js/session-store.js'),'utf8');
 try{w.eval(code);w.GNSession.saveIdentity('old');w.localStorage.setItem('gn_identity','new-tab-token');w.GNSession.invalidateIdentity('old');assert.equal(w.localStorage.getItem('gn_identity'),'new-tab-token');assert.equal(w.GNSession.getIdentity(),'');w.eval(code);assert.equal(w.GNSession.getIdentity(),'','refresh retains per-tab block');w.GNSession.saveIdentity('explicit-login');assert.equal(w.GNSession.getIdentity(),'explicit-login');}finally{w.close()}
});

test('local login history survives logout and only explicit success records a name',()=>{
 const d=new JSDOM('',{url:'http://localhost',runScripts:'outside-only'}),w=d.window;try{w.eval(fs.readFileSync(path.join(__dirname,'../public/js/session-store.js'),'utf8'));w.localStorage.setItem('gn_name','unverified');assert.equal(w.GNSession.getLoginHistory().length,0);w.GNSession.rememberLogin('confirmed','a');w.GNSession.rememberLogin('renamed','a');assert.equal(w.GNSession.getLoginHistory().length,1);w.GNSession.saveIdentity('active');w.GNSession.set({roomId:'room',resumeToken:'resume'});w.GNSession.logout();assert.equal(w.GNSession.getIdentity(),'');assert.equal(w.GNSession.get(),null);assert.equal(w.GNSession.getLoginHistory()[0].name,'renamed');}finally{w.close()}
});

test('suspended old tab without a replacement event cannot borrow a newer login on refresh',()=>{
 const d=new JSDOM('',{url:'http://localhost',runScripts:'outside-only'}),w=d.window,code=fs.readFileSync(path.join(__dirname,'../public/js/session-store.js'),'utf8');
 try{
  w.eval(code);w.localStorage.setItem('gn_identity','original-token');assert.equal(w.GNSession.getIdentity(),'original-token');
  w.localStorage.setItem('gn_identity','new-login-token');w.localStorage.setItem('gn_session',JSON.stringify({roomId:'NEW',savedAt:Date.now()}));
  w.eval(code);assert.equal(w.GNSession.getIdentity(),'original-token','reload uses its own stale token, which the server rejects');
  w.GNSession.invalidateIdentity('original-token');assert.equal(w.localStorage.getItem('gn_identity'),'new-login-token');assert.equal(JSON.parse(w.localStorage.getItem('gn_session')).roomId,'NEW');assert.equal(w.GNSession.getIdentity(),'');
 }finally{w.close();}
});
