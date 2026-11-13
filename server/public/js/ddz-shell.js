/* One connection owns identity, lobby and table state. Apache-2.0. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const renderer = window.gameRenderers.get('doudizhu');
  let ws, retryTimer, heartbeatTimer, watchdog, requestTimer, activeToken = '', profile = '', userId = '';
  let table = null, state = null, players = [], self = -1, phase = '', options = {}, dissolution = null;
  let pending = null, counter = 0, retryCount = 0, renaming = false, rendererMounted = false, disposed = false;
  let listRequest = 0, listSignature = '', lastPong = 0, toastTimer, dialogFocus, dialogKind = '';
  let muted = true, audioContext;
  try { muted = localStorage.getItem('gn_sound') !== 'on'; } catch (_) {}
  const requestPrefix = Math.random().toString(36).slice(2);
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
  const status = text => { $('persistentStatus').textContent = text || ''; };
  const connected = () => ws && ws.readyState === 1;
  const me = () => players.find(p => p.index === self);
  function toast(text) {
    $('shellToast').textContent = text; $('shellToast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('shellToast').hidden = true; }, 3500);
  }
  window.showToast = toast;
  function lockControls() {
    const disabled = !!pending || !connected();
    for (const id of ['identitySubmit','createBtn','joinBtn','logoutBtn','renameBtn','readyBtn','leaveBtn']) $(id).disabled = disabled;
    document.querySelectorAll('.gn-user-card,.gn-room-card>button').forEach(b => { b.disabled = disabled || b.dataset.unavailable === '1'; });
    window._gnMoveBusy = !!pending || !connected();
    if (table && phase === 'playing') renderGame();
    if (table && phase !== 'playing') updateStart();
  }
  function send(type, data = {}, done) {
    if (pending) return false;
    if (!connected()) { toast('连接中断，正在恢复。座位与手牌会保留。'); return false; }
    const requestId = requestPrefix + '-' + (++counter);
    pending = {requestId, type, done};
    ws.send(JSON.stringify({type, data, requestId}));
    requestTimer = setTimeout(() => {
      if (!pending || pending.requestId !== requestId) return;
      pending = null; lockControls();
      status('操作结果尚未确认，正在重新同步。');
      // Never replay a move automatically after an uncertain network result.
      if (ws) ws.close();
    }, 8000);
    lockControls();
    return true;
  }
  function clearPending() { clearTimeout(requestTimer); const old = pending; pending = null; return old; }
  function connectionLabel(text) { $('connectionState').textContent = text; $('tableConnection').textContent = text; }
  function showHall() {
    table = null; state = null; players = []; self = -1; phase = ''; rendererMounted = false;
    if (renderer.dispose) renderer.dispose();
    $('boardArea').replaceChildren(); $('presencePanel').hidden = true;
    document.body.classList.remove('at-table');
    $('roomPanel').hidden = true; $('hallPanel').hidden = !profile; $('identityPanel').hidden = !!profile;
    $('profileLabel').textContent = '你好，' + profile;
    $('cancelRename').hidden = true; $('userDirectory').hidden = false;
    if (profile) { listSignature = ''; refreshRooms(); } else refreshUsers();
  }
  function signOut(message) {
    clearPending(); activeToken = activeToken || GNSession.getIdentity();
    GNSession.invalidateIdentity(activeToken); activeToken = ''; profile = ''; userId = ''; renaming = false;
    $('identitySubmit').textContent = '进入大厅'; $('identityError').textContent = message || '';
    $('identityName').value = '';
    showHall(); status(message); lockControls();
    if (ws) { ws.onclose = null; ws.close(); }
    connect();
  }
  function connect() {
    clearTimeout(retryTimer); clearInterval(heartbeatTimer); clearTimeout(watchdog);
    if (disposed) return;
    if (ws && [0,1].includes(ws.readyState)) return;
    const socket = ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host);
    connectionLabel(retryCount ? '正在重连…' : '连接中…');
    socket.onopen = () => {
      if (ws !== socket || disposed) return;
      lastPong = Date.now(); retryCount = 0; connectionLabel('已连接'); lockControls();
      activeToken = GNSession.getIdentity();
      if (activeToken) send('identify', {identityToken: activeToken});
      else { profile = ''; showHall(); }
      heartbeatTimer = setInterval(() => {
        if (!connected() || document.visibilityState === 'hidden') return;
        if (Date.now() - lastPong > 40000) { socket.close(); return; }
        socket.send(JSON.stringify({type:'ping'}));
      },10000);
    };
    socket.onmessage = event => {
      if (ws !== socket || disposed) return;
      let message; try { message = JSON.parse(event.data); } catch (_) { return; }
      lastPong = Date.now();
      receive(message);
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (ws !== socket || disposed) return;
      clearInterval(heartbeatTimer); clearPending();
      connectionLabel('正在重连…'); status('连接中断，正在重连；座位、手牌与积分保留。');
      lockControls();
      retryTimer = setTimeout(connect,Math.min(8000,700 * 2 ** Math.min(retryCount++,4)));
    };
    watchdog = setTimeout(() => { if (socket.readyState === 0) socket.close(); },10000);
  }
  function receive(m) {
    if (m.type === 'pong') return;
    if (m.identityToken) { activeToken = m.identityToken; GNSession.saveIdentity(activeToken); }
    if (m.type === 'session_replaced' || m.type === 'error' && m.code === 'IDENTITY_INVALID') {
      signOut('此用户已在其他位置登录。请手动选择用户重新登录。'); return;
    }
    if (m.type === 'logged_out') { GNSession.logout(); signOut('已登出。请手动选择用户或输入昵称登录。'); return; }
    if (m.type === 'action_result') {
      if (!pending || pending.requestId !== m.requestId) return;
      const action = clearPending();
      lockControls();
      if (!m.ok) { if (m.message) status(m.message); return; }
      if (action.done) action.done();
      return;
    }
    if (m.type === 'error') {
      $('identityError').textContent = m.message || '操作未完成。'; status(m.message); toast(m.message || '操作未完成。');
      if (m.code === 'ROOM_NOT_FOUND') { GNSession.clear(); showHall(); }
      return;
    }
    if (m.type === 'identified') {
      profile = m.name; userId = m.userId || userId; renaming = false;
      GNSession.saveName(profile); GNSession.rememberLogin(profile,userId);
      $('identityError').textContent = ''; $('identitySubmit').textContent = '进入大厅'; status('');
      if (!table) showHall();
      const invitation = new URLSearchParams(location.search).get('room');
      const target = m.roomId || (!table && invitation);
      // Wait for this identify request's own acknowledgement before joining.
      if (target && pending) pending.done = () => join(target);
      else if (target) join(target);
      return;
    }
    if (m.type === 'room_created' || m.type === 'room_joined') {
      const changed = table !== m.roomId;
      table = m.roomId; self = m.playerIndex; phase = m.phase; options = m.options || {};
      players = m.players || []; state = m.state || null; dissolution = m.dissolution;
      GNSession.set(m); GNSession.touch();
      document.body.classList.add('at-table'); $('identityPanel').hidden = true; $('hallPanel').hidden = true; $('roomPanel').hidden = false;
      $('roomBadge').textContent = '牌桌 ' + table;
      if (changed) { rendererMounted = false; $('qrImage').src = '/qr?room=' + encodeURIComponent(table); $('qrRoomCode').textContent = table; }
      status(''); renderRoom(); return;
    }
    if (m.type === 'left_room' || m.type === 'room_dissolved') {
      GNSession.clear(); showHall();
      if (new URLSearchParams(location.search).has('room')) history.replaceState(null,'',location.pathname);
      status(m.type === 'left_room' ? '已离桌。' : '牌桌已解散，本局不计分。已完成积分：' + (m.scores || []).join(' / ')); return;
    }
    if (['room_update','player_joined','player_left','game_started','game_state'].includes(m.type)) {
      if (!table) return;
      const previousActor = state?.currentPlayer;
      if (m.players) players = m.players;
      if (m.phase) phase = m.phase;
      if (m.options) options = m.options;
      if (m.dissolution) dissolution = m.dissolution;
      if (m.type === 'game_started') rendererMounted = false;
      if (m.state) { state = m.state; phase = 'playing'; }
      if (m.state && previousActor !== state.currentPlayer && state.currentPlayer === self && !state.paused) turnSound();
      renderRoom(); return;
    }
    if (m.type === 'restart_requested') toast(m.by + ' 希望再开一轮。');
  }
  function refreshUsers() {
    if (profile || renaming) return;
    const box = $('userCards'); box.replaceChildren();
    for (const u of GNSession.getLoginHistory()) {
      const b = node('button','gn-user-card',u.name); b.type = 'button';
      b.onclick = () => { $('identityName').value = u.name; send('identify',{name:u.name}); }; box.append(b);
    }
    if (!box.children.length) box.append(node('p','gn-note','此浏览器还没有登录记录。'));
    lockControls();
  }
  function join(roomId) { send('join_room',{roomId:String(roomId).trim().toUpperCase(),identityToken:activeToken,lang:'zh'}); }
  async function refreshRooms() {
    if (table || !profile || renaming) return;
    const request = ++listRequest;
    try {
      const response = await fetch('/api/rooms',{cache:'no-store'});
      if (!response.ok) throw Error('unavailable');
      const data = await response.json();
      if (request !== listRequest || table || !profile) return;
      const rooms = data.rooms || [], signature = JSON.stringify(rooms);
      $('roomCount').textContent = rooms.length ? '· ' + rooms.length + ' 桌' : '';
      if (signature === listSignature) return;
      listSignature = signature;
      const list = $('roomsList'); list.replaceChildren();
      if (!rooms.length) {
        const empty = node('div','gn-empty-list'); empty.append(node('span','','♣'),node('h3','','第一桌，等你来开'),node('p','gn-note','创建牌桌后，把房间号分享给朋友。'));list.append(empty);
      }
      for (const room of rooms) {
        const card = node('article','gn-room-card'); card.dataset.roomId = room.roomId;
        const heading = node('div','gn-room-heading');
        const label = room.status === 'paused' ? (room.seats.some(p=>p.vacant)?'暂停 · 等待补位':'暂停 · 等待重连') : ({playing:'正在对局',finished:'本轮结束',full:'三人已就位',waiting:'等待入座'}[room.status] || '等待入座');
        heading.append(node('strong','','牌桌 '+room.roomId),node('span','gn-room-status',label));
        const mini = node('div','gn-mini-table'); mini.setAttribute('aria-label','三席圆桌');
        mini.append(node('span','gn-table-center',room.playerCount+'/3'));
        for (let index=0;index<3;index++) {
          const p=room.seats.find(s=>s.index===index) || {vacant:true};
          const seat=node('div','gn-room-seat seat-'+index+(p.vacant?' is-vacant':''));
          const name=p.vacant?'空席':p.name;
          const avatar=node('span','gn-room-seat-icon',p.vacant?'+':[...name][0]);avatar.setAttribute('aria-hidden','true');
          const nickname=node('span','gn-room-seat-name',name);nickname.title=name;
          seat.append(avatar,nickname,node('small','',p.vacant?'可入座':p.online?'在线':'离线 · 保留座位'));mini.append(seat);
        }
        const b=node('button','btn btn-accent',room.canJoin?(room.paused?'接替空席':'入座'):room.status==='playing'?'对局中':'暂时满员');
        b.dataset.unavailable=room.canJoin?'0':'1';b.onclick=()=>join(room.roomId);
        const watch=node('a','btn btn-outline gn-watch-link','观战');
        watch.href='/watch.html?room='+encodeURIComponent(room.roomId);
        card.append(heading,mini,b,watch);list.append(card);
      }
      lockControls();
    } catch (_) { if(request===listRequest) status('牌桌列表暂时无法加载。可按房间号加入，或稍后刷新。'); }
  }
  function updateStart() {
    const host=!!me()?.isHost;
    $('startGameBtn').hidden=!host;
    $('startGameBtn').disabled=!!pending || !connected() || players.length!==3 || players.some(p=>!p.ready || !p.online);
  }
  function renderRoom() {
    $('waitingRoom').hidden=phase==='playing';$('gameStage').hidden=phase!=='playing';
    if (phase==='playing') renderGame(); else renderWaiting();
    renderPresence();
    if (!$('infoDialog').hidden && dialogKind==='scores') scoreContent();
  }
  function renderWaiting() {
    const slots=$('waitingSlots');slots.replaceChildren();
    for(let index=0;index<3;index++){
      const p=players.find(p=>p.index===index);
      const slot=node('div','gn-wait-seat'+(!p?' is-vacant':''));
      slot.append(node('span','gn-wait-avatar',p?.avatar || '＋'),node('strong','',p?(p.name+(index===self?'（你）':'')):'等待朋友'),node('span','gn-note',p?(p.online?(p.ready?'已准备':'未准备'):'离线 · 等待重连'):'分享房间号邀请入座'));
      if(p?.isHost)slot.append(node('small','gn-host-tag','房主'));
      if(index===self){slot.tabIndex=0;slot.setAttribute('role','button');slot.setAttribute('aria-label','更换我的头像');slot.onclick=chooseAvatar;slot.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();chooseAvatar();}};}
      slots.append(slot);
    }
    $('readyBtn').textContent=me()?.ready?'取消准备':'准备';
    $('readyBtn').classList.toggle('btn-accent',!me()?.ready);
    const optionBox=$('gameOptions'), signature=JSON.stringify([options,!!me()?.isHost]);
    if(optionBox.dataset.signature!==signature){
      optionBox.dataset.signature=signature;optionBox.replaceChildren();
      if(me()?.isHost){
        const label=node('label','','局数 '),input=node('input');input.type='number';input.min=1;input.max=30;input.value=options.totalRounds||3;input.setAttribute('aria-label','本桌局数');
        input.onchange=()=>send('set_option',{key:'totalRounds',value:Number(input.value)});label.append(input);
        const bidLabel=node('label','','叫地主 '),select=node('select');select.setAttribute('aria-label','叫地主方式');
        for(const [value,text] of [['score','叫分'],['rob','叫抢']]){const option=node('option','',text);option.value=value;select.append(option);}select.value=options.bidMode||'score';select.onchange=()=>send('set_option',{key:'bidMode',value:select.value});bidLabel.append(select);
        const priv=node('label','','仅凭房间号加入 '),check=node('input');check.type='checkbox';check.checked=!!options.isPrivate;check.onchange=()=>send('set_private',{isPrivate:check.checked});priv.append(check);optionBox.append(label,bidLabel,priv);
      }else optionBox.textContent=`${options.totalRounds||3} 局 · ${options.bidMode==='rob'?'叫抢':'叫分'} · 底分 1 · 128 倍封顶`;
    }
    updateStart();
    $('waitingStatus').textContent=players.length<3?'还差 '+(3-players.length)+' 位朋友。':players.some(p=>!p.online)?'有玩家离线，等待重连。':players.every(p=>p.ready)?(me()?.isHost?'大家准备好了，可以开始。':'等待房主开始。'):'等待所有玩家准备。';
  }
  function renderGame() {
    if(!state || !table)return;
    if(!rendererMounted){renderer.init($('boardArea'));rendererMounted=true;}
    window.gamePlayers=Array.from({length:3},(_,i)=>players.find(p=>p.index===i)||{name:'空位',vacant:true});
    const visibleState=connected()?state:{...state,paused:true};
    renderer.render(visibleState,$('boardArea'),self,state.winner);
    if(window._gnMoveBusy)document.querySelectorAll('#ddzActions button,#ddzVotePanel button').forEach(b=>b.disabled=true);
  }
  function renderPresence() {
    const box=$('presencePanel');const opened=!!box.querySelector('details[open]');box.replaceChildren();
    const absent=players.filter(p=>p.vacant||p.online===false);
    box.hidden=!table || !absent.length;if(box.hidden)return;
    const details=node('details'),summary=node('summary','',absent.some(p=>p.vacant)?'空席待补位 · 查看':'有人离线 · 查看');details.open=opened;
    const content=node('div','gn-presence-content');
    content.append(node('p','',absent.map(p=>(p.vacant?'空席':p.name)+' · '+(p.vacant?'等待接替':'等待重连')).join('　')));
    content.append(node('p','',absent.some(p=>p.vacant)?'新玩家可从大厅接替空席，继承手牌与积分。三人在线后继续。':'关闭页面会保留座位；主动离桌后才可由其他用户接替。'));
    if(dissolution?.eligible){
      const voted=dissolution.votes.includes(self),b=node('button','btn btn-outline btn-sm',voted?'撤回解散':'同意解散');
      b.onclick=()=>send('dissolve_vote',{agree:!voted});b.disabled=!!pending;
      content.append(node('p','','已离线超过两分钟。两位在线玩家都同意后解散，未完成局不计分。'),b);
    }
    details.append(summary,content);box.append(details);
  }
  function dialog(title,kind='') { dialogKind=kind;dialogFocus=document.activeElement;$('dialogTitle').textContent=title;$('dialogBody').replaceChildren();$('infoDialog').hidden=false;$('closeDialog').focus(); }
  function closeDialog(){ $('infoDialog').hidden=true;dialogKind='';dialogFocus?.focus(); }
  function scoreContent(){
    const body=$('dialogBody');body.replaceChildren();
    const scores=state?.cumulativeScore || [0,0,0];
    const tableEl=node('table','gn-score-table'),head=node('tr');for(const text of ['名次','玩家 / 席位','累计积分'])head.append(node('th','',text));tableEl.append(head);
    [...Array(3).keys()].sort((a,b)=>scores[b]-scores[a]).forEach((i,rank)=>{const row=node('tr');row.append(node('td','',String(rank+1)),node('td','',players.find(p=>p.index===i)?.name || '空席'),node('td','',String(scores[i])));tableEl.append(row);});body.append(tableEl,node('p','gn-note','积分属于本桌席位；接替空席时一并继承。'));
    const history=state?.roundHistory || [];
    if(history.length){body.append(node('h3','','已完成对局'));const list=node('ol','gn-history');history.slice(-30).forEach(r=>list.append(node('li','',`第 ${r.round} 局 · ${r.multiplier} 倍${r.spring?' · '+(r.spring==='spring'?'春天':'反春天'):''} · ${r.deltas.map(n=>n>0?'+'+n:n).join(' / ')}`)));body.append(list);}
  }
  function chooseAvatar(){dialog('选择头像');for(const avatar of ['😊','🐼','🐱','🦊','🐯','🐸','🐶','😎','🌟','🍀','🚀','🌙']){const b=node('button','gn-avatar-choice',avatar);b.onclick=()=>{send('set_avatar',{avatar});closeDialog();};$('dialogBody').append(b);}}
  function turnSound(){if(muted||!audioContext)return;try{const oscillator=audioContext.createOscillator(),gain=audioContext.createGain();oscillator.frequency.value=660;gain.gain.setValueAtTime(.08,audioContext.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audioContext.currentTime+.2);oscillator.connect(gain);gain.connect(audioContext.destination);oscillator.start();oscillator.stop(audioContext.currentTime+.2);}catch(_){} }
  function updateMute(){ $('muteBtn').textContent=muted?'🔇':'🔊';$('muteBtn').setAttribute('aria-label',muted?'开启回合提示音':'关闭回合提示音'); }
  $('muteBtn').onclick=()=>{muted=!muted;try{localStorage.setItem('gn_sound',muted?'off':'on');if(!muted){const Audio=window.AudioContext||window.webkitAudioContext;if(Audio){audioContext ||= new Audio();audioContext.resume();turnSound();}}}catch(_){}updateMute();};updateMute();
  $('identityForm').onsubmit=e=>{e.preventDefault();$('identityError').textContent='';send(renaming?'set_name':'identify',{name:$('identityName').value});};
  $('renameBtn').onclick=()=>{renaming=true;$('identityName').value=profile;$('identitySubmit').textContent='保存昵称';$('cancelRename').hidden=false;$('userDirectory').hidden=true;$('identityPanel').hidden=false;$('hallPanel').hidden=true;$('identityName').focus();};
  $('cancelRename').onclick=()=>{renaming=false;$('identitySubmit').textContent='进入大厅';showHall();};
  $('logoutBtn').onclick=()=>send('logout');
  $('createForm').onsubmit=e=>{e.preventDefault();send('create_room',{game:'doudizhu',identityToken:activeToken,options:{totalRounds:Number($('roundCount').value),bidMode:'score'}});};
  $('joinForm').onsubmit=e=>{e.preventDefault();join($('joinCode').value);};
  $('refreshRooms').onclick=()=>{listSignature='';refreshRooms();};
  $('readyBtn').onclick=()=>send('player_ready',{ready:!me()?.ready});
  $('startGameBtn').onclick=()=>send('start_game');
  window.doLeaveRoom=()=>send('leave_room');$('leaveBtn').onclick=window.doLeaveRoom;
  window.doRestart=()=>send(me()?.isHost?'game_restart':'request_restart');
  window.doReturnToRoom=()=>send('return_to_room');
  window.makeGameMove=data=>{if(!table || !state || state.paused)return;send('game_move',{...data,expectedRevision:state.revision});};
  $('scoresBtn').onclick=()=>{dialog('本桌排行榜','scores');scoreContent();};
  $('rulesBtn').onclick=()=>{dialog('斗地主规则');for(const text of ['三位玩家使用 54 张牌，地主 20 张、农民各 17 张。地主先出；先出完手牌的一方获胜。','牌从大到小：大王、小王、2、A、K、Q、J、10 至 3。支持单张、对子、三张及带牌、顺子、连对、飞机、四带二、炸弹和王炸。顺子及飞机不含 2 和王。','底分 1。叫分或叫抢决定起始倍数；炸弹、王炸、春天及反春天翻倍，总倍数最多 128。地主输赢为两份，农民各一份，三席积分零和。','春天：地主获胜时农民都没出过牌。反春天：农民获胜时地主只出过一次牌。','末局三人一致同意可延长 3 局。无人自动出牌；缺人暂停，断线可恢复原席。主动离桌才会空出席位，接替者继承手牌和积分。'])$('dialogBody').append(node('p','',text));};
  $('shareLinkBtn').onclick=async()=>{const url=location.origin+'/?room='+encodeURIComponent(table);try{if(navigator.share){await navigator.share({title:'一起斗地主',url});return;}if(navigator.clipboard && window.isSecureContext){await navigator.clipboard.writeText(url);toast('链接已复制');return;}}catch(e){if(e.name==='AbortError')return;}dialog('分享牌桌');$('dialogBody').append(node('p','', '发送房间号 '+table+'，或复制以下链接：'));const input=node('input');input.value=url;input.readOnly=true;input.setAttribute('aria-label','牌桌分享链接');$('dialogBody').append(input);input.focus();input.select();};
  $('closeDialog').onclick=closeDialog;$('infoDialog').onclick=e=>{if(e.target===$('infoDialog'))closeDialog();};
  document.addEventListener('keydown',e=>{if($('infoDialog').hidden)return;if(e.key==='Escape'){closeDialog();return;}if(e.key==='Tab'){const all=[...$('infoDialog').querySelectorAll('button,input,select,[tabindex="0"]')].filter(el=>!el.disabled);const first=all[0],last=all[all.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){if(connected()&&Date.now()-lastPong>40000)ws.close();else if(!connected())connect();if(!table)refreshRooms();}});
  const refreshTimer=setInterval(()=>{if(document.visibilityState!=='hidden')refreshRooms();},5000);
  window.addEventListener('pagehide',()=>{clearInterval(heartbeatTimer);});
  window.addEventListener('pageshow',e=>{if(e.persisted){if(ws){ws.onclose=null;ws.close();}connect();}});
  // Used by the DOM harness and page disposal; a single owner prevents reconnect leaks.
  window.GNDisposeApp=()=>{disposed=true;clearTimeout(retryTimer);clearTimeout(requestTimer);clearTimeout(watchdog);clearInterval(heartbeatTimer);clearInterval(refreshTimer);if(renderer.dispose)renderer.dispose();if(ws){ws.onclose=null;ws.close();}};
  connect();
})();
