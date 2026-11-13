/* Anonymous public view: no identity/session storage and no player actions. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const node = (tag, cls, text) => { const el=document.createElement(tag);el.className=cls || '';if(text!=null)el.textContent=text;return el; };
  let ws, retry, poll, heartbeat, disposed=false, roomId=new URLSearchParams(location.search).get('room') || '', sequence=0;
  roomId=roomId.trim().toUpperCase();$('watchCode').value=roomId;
  const status = text => { $('watchStatus').textContent=text; };
  const name = (players,i) => players.find(p=>p.index===i)?.name || '空席';
  const cardText = c => ({s:'♠',h:'♥',c:'♣',d:'♦'}[c.suit] || '') + c.rank;
  function watch(id) {
    if(!ws || ws.readyState!==1){status('正在连接，请稍候。');return;}
    ws.send(JSON.stringify({type:'watch_room',data:{roomId:id},requestId:'watch-'+(++sequence)}));
  }
  const renderer=Object.create(window.gameRenderers.get('doudizhu'));
  let latest=null, mounted=false, perspective=0;
  window._gnMoveBusy=true;
  // Reuse the actual game renderer with two read-only rendering overrides.
  renderer.renderHand=function(state,index){
    const count=state.hands[index].length;
    $('ddzHand').innerHTML='<div class="watch-hidden-hand" style="--n:'+Math.max(1,count)+'">'+Array.from({length:count},()=>window.CardUI.render(null,{size:'md',attrs:'aria-hidden="true"'})).join('')+'</div>';
    $('ddzHand').setAttribute('aria-label','手牌已隐藏，剩余 '+count+' 张');
    $('ddzSelectionStatus').textContent='手牌已隐藏 · 剩余 '+count+' 张';
  };
  renderer.renderActions=function(state){$('ddzActions').replaceChildren(node('span','watch-readonly',state.paused?'牌局暂停 · 等待玩家在线':'只读观战 · 无法参与出牌或投票'));};
  function scores(){
    if(!latest)return;
    const box=$('watchScoresBody');box.replaceChildren();const players=latest.players || [],state=latest.state;
    const list=node('ol');[0,1,2].sort((a,b)=>(state?.cumulativeScore?.[b]||0)-(state?.cumulativeScore?.[a]||0)).forEach(i=>list.append(node('li','',name(players,i)+' · '+(state?.cumulativeScore?.[i] || 0)+' 分')));box.append(list);
    box.append(node('h3','','已完成对局'));const historyList=node('ol');
    for(const r of (state?.roundHistory || []).slice(-30))historyList.append(node('li','',`第 ${r.round} 局 · ${r.multiplier} 倍 · ${r.deltas.map((n,i)=>name(players,i)+' '+(n>0?'+':'')+n).join(' / ')}`));
    if(!historyList.children.length)historyList.append(node('li','','暂无已结算对局。'));box.append(historyList);
  }
  function render(m) {
    const state=m.state, players=m.players || [];latest=m;
    if(roomId!==m.roomId){mounted=false;renderer.dispose();}
    roomId=m.roomId;$('watchCode').value=roomId;
    history.replaceState(null,'','/watch.html?room='+encodeURIComponent(roomId));
    document.body.classList.add('at-table');$('roomPanel').hidden=false;$('watchDirectory').hidden=true;
    $('watchTitle').textContent='观战 · '+roomId;
    status(state?.paused?'已连接 · 牌局暂停，等待三位玩家在线。':'已连接 · 实时观战，三家手牌均隐藏。');
    $('watchSeat').replaceChildren();for(let i=0;i<3;i++){const option=node('option','',name(players,i)+' 视角');option.value=String(i);$('watchSeat').append(option);}$('watchSeat').value=String(perspective);
    $('watchWaiting').hidden=!!state;$('gameStage').hidden=!state;
    if(state){
      if(!mounted){renderer.init($('boardArea'));mounted=true;}
      window.gamePlayers=Array.from({length:3},(_,i)=>players.find(p=>p.index===i)||{name:'空席',vacant:true});
      renderer.render(state,$('boardArea'),perspective,state.winner);
      $('ddzVotePanel').replaceChildren();
      $('ddzSelfSeat').querySelector('.ddz-seat-name').textContent='观战 · '+name(players,perspective);
      const clock=document.querySelector('.ddz-turn-clock strong');if(clock)clock.textContent=name(players,state.currentPlayer);
      const played=document.querySelector('.ddz-last-play>div');if(played && state.lastPlay?.player===perspective)played.textContent=name(players,perspective)+' 出牌';
    }else{
      if(mounted){renderer.dispose();mounted=false;$('boardArea').replaceChildren();}
      const slots=$('waitingSlots');slots.replaceChildren();
      for(let i=0;i<3;i++){const player=players.find(p=>p.index===i),seat=node('div','gn-wait-seat');seat.append(node('span','gn-wait-avatar',player?.avatar || '＋'),node('strong','',name(players,i)),node('span','gn-note',!player||player.vacant?'等待入座':!player.online?'离线 · 等待重连':player.ready?'已准备':'未准备'));slots.append(seat);}
    }
    if(!$('watchScores').hidden)scores();
  }
  function showDirectory(){roomId='';latest=null;mounted=false;renderer.dispose();$('boardArea').replaceChildren();$('roomPanel').hidden=true;$('watchDirectory').hidden=false;document.body.classList.remove('at-table');}
  $('watchSeat').onchange=()=>{perspective=Number($('watchSeat').value);if(latest)render(latest);};
  $('watchScoresBtn').onclick=()=>{scores();$('watchScores').hidden=false;$('watchCloseScores').focus();};
  $('watchCloseScores').onclick=()=>{$('watchScores').hidden=true;$('watchScoresBtn').focus();};
  document.addEventListener('keydown',e=>{if(e.key==='Escape')$('watchCloseScores').click();});
  async function directory(){
    if(roomId)return;
    try{const response=await fetch('/api/rooms',{cache:'no-store'});if(!response.ok)throw Error();const data=await response.json();if(roomId)return;const list=$('watchRooms');list.replaceChildren();
      for(const room of data.rooms || []){const a=node('a','btn btn-outline',`牌桌 ${room.roomId} · ${room.playerCount}/3 人`);a.href='/watch.html?room='+encodeURIComponent(room.roomId);list.append(a);}
      if(!list.children.length)list.append(node('p','gn-note','暂无公开牌桌，也可输入朋友提供的房间号。'));
    }catch(_){status('牌桌列表暂时无法加载，请输入房间号或稍后刷新。');}
  }
  function connect(){
    if(disposed)return;
    ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host);
    ws.onopen=()=>{status('已连接，请选择牌桌。');if(roomId)watch(roomId);};
    ws.onmessage=event=>{let m;try{m=JSON.parse(event.data);}catch(_){return;}
      if(m.type==='error'){status(m.message || '无法观战。');if(m.code==='ROOM_NOT_FOUND'){showDirectory();directory();}return;}
      if(m.type==='room_dissolved'){showDirectory();history.replaceState(null,'','/watch.html');status('牌桌已关闭，请选择其他牌桌。');directory();return;}
      if(m.spectator && m.roomId)render(m);
    };
    ws.onerror=()=>{};
    ws.onclose=()=>{status('连接中断，正在恢复观战；当前画面可能已过期。');if(!disposed)retry=setTimeout(connect,1000);};
  }
  $('watchForm').onsubmit=e=>{e.preventDefault();const id=$('watchCode').value.trim().toUpperCase();if(id)watch(id);};
  heartbeat=setInterval(()=>{if(ws?.readyState===1)ws.send(JSON.stringify({type:'ping'}));},10000);
  poll=setInterval(directory,5000);
  window.GNDisposeWatch=()=>{disposed=true;renderer.dispose();clearTimeout(retry);clearInterval(poll);clearInterval(heartbeat);if(ws){ws.onclose=null;ws.close();}};
  window.addEventListener('pagehide',window.GNDisposeWatch);
  window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});
  connect();directory();
})();
