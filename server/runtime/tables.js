'use strict';
// GameNest landlord-only runtime. Upstream license and attribution: LICENSE/NOTICE.
const crypto = require('node:crypto');
const game = require('../games/doudizhu');
const { maskView } = require('../games/lib/hidden');
const zh = require('../lang/server-zh');
const { StateStore } = require('./state-store');
const normalizeName = v => typeof v === 'string' ? v.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
const nameKey = v => normalizeName(v).toLowerCase();
const freshToken = () => crypto.randomBytes(32).toString('base64url');
const finished = r => r.state && (r.state.winner != null || r.state.phase === 'over');
const online = (ws, p) => ws.readyState === 1 && !ws.revoked && !p.disconnectedAt;
const validName = n => n && [...n].length <= 16 && !/[<>\u0000-\u001f\u007f\p{Cf}]/u.test(n);
const mutationTypes = new Set(['identify','logout','create_room','join_room','set_name','set_avatar','player_ready','start_game','set_option','set_private','game_move','leave_room','dissolve_vote','return_to_room','game_restart']);

class Tables {
  constructor(file, sockets, onFailure) {
    this.store = new StateStore(file);
    this.sockets = sockets;
    this.onFailure = onFailure;
    this.rooms = new Map();
    this.identities = new Map();
    this.byName = new Map();
    this.effects = null;
    this.failed = false;
    this.offlineVoteMs = process.env.NODE_ENV === 'test' ? Number(process.env.TEST_OFFLINE_VOTE_MS || 120000) : 120000;
    const saved = this.store.load();
    // Older releases retained empty playing tables. Remove only genuinely vacant
    // tables; disconnected occupants still have saved seats and must survive.
    const occupiedRooms = saved.rooms.filter(room => room.players.length > 0);
    if (occupiedRooms.length !== saved.rooms.length) {
      saved.rooms = occupiedRooms;
      this.store.save(saved); // Preserve every occupied table and identity verbatim.
    }
    // Keep unknown top-level fields so version-1 snapshots can be extended safely.
    this.extra = Object.fromEntries(Object.entries(saved).filter(([k]) => !['version','identities','rooms'].includes(k)));
    for (const [token, identity] of saved.identities) { this.identities.set(token, identity); this.byName.set(nameKey(identity.name), identity); }
    for (const savedRoom of saved.rooms) {
      const room = { ...savedRoom, options: savedRoom.options || {}, revision: savedRoom.revision || 0,
        players: new Map(), readyPlayers: new Set(savedRoom.readyPlayers || []), votes: new Set(), host: null };
      for (const p of savedRoom.players) {
        const disconnected = { readyState: 3 };
        const info = { ...p, disconnectedAt: Date.now() };
        room.players.set(disconnected, info);
        if (p.index === savedRoom.hostIndex) room.host = disconnected;
      }
      this.rooms.set(room.id, room);
    }
  }
  snapshot() {
    return { ...this.extra, version: 1, identities: [...this.identities], rooms: [...this.rooms.values()].map(r => ({
      id: r.id, game: 'doudizhu', maxPlayers: 3, lang: r.lang || 'zh', phase: r.phase,
      state: r.state, options: r.options, isPrivate: !!r.isPrivate, createdAt: r.createdAt,
      revision: r.revision, readyPlayers: [...r.readyPlayers], hostIndex: r.players.get(r.host)?.index,
      players: [...r.players.values()].map(p => ({ name: p.name, identityId: p.identityId, index: p.index,
        avatar: p.avatar, resumeToken: p.resumeToken, disconnectedAt: p.disconnectedAt }))
    })) };
  }
  // State commits before any success message or broadcast. A write failure closes
  // the runtime without acknowledging uncommitted changes; supervisor restores the checkpoint.
  transaction(fn, persist = true) {
    if (this.failed) return;
    this.effects = [];
    try {
      fn();
      if (persist) this.store.save(this.snapshot());
      const effects = this.effects;
      this.effects = null;
      for (const effect of effects) effect();
    } catch (e) {
      this.effects = null;
      this.failed = true;
      console.error('[tables] checkpoint/handler failure:', e.message);
      this.onFailure(e);
    }
  }
  effect(fn) { if (this.effects) this.effects.push(fn); else fn(); }
  send(ws, msg) {
    const text = JSON.stringify(msg);
    this.effect(() => { if (ws.readyState === 1) { try { ws.send(text); } catch (_) {} } });
  }
  error(ws, code, message, requestId) {
    ws.lastActionError = { code, message: message || zh[code] || code };
    this.send(ws, { type: 'error', ...ws.lastActionError, ...(requestId ? { requestId } : {}) });
  }
  paused(room) { return room.phase === 'playing' && [...room.players].filter(([ws,p]) => online(ws,p)).length < 3; }
  dissolution(room) {
    const off = [], on = [];
    for (const [ws,p] of room.players) {
      if (online(ws,p)) on.push(p.index);
      else if (p.disconnectedAt && Date.now() - p.disconnectedAt >= this.offlineVoteMs) off.push(p.index);
    }
    return { eligible: room.players.size === 3 && on.length === 2 && off.length === 1, votes: [...room.votes], offlineSeats: off };
  }
  players(room) {
    return Array.from({length:3}, (_,index) => {
      const entry = [...room.players].find(([,p]) => p.index === index);
      if (!entry) return { index, name: '空位', vacant: true, isBot: false, isHost: false, ready: false, connected: false, online: false, avatar: '', score: room.state?.cumulativeScore?.[index] || 0 };
      const [ws,p] = entry;
      return { index, name: p.name, vacant: false, isBot: false, isHost: room.host === ws, ready: room.readyPlayers.has(index),
        connected: online(ws,p), online: online(ws,p), avatar: p.avatar || '😊', disconnectedAt: p.disconnectedAt || null, score: room.state?.cumulativeScore?.[index] || 0 };
    }).filter(p => room.phase === 'playing' || !p.vacant);
  }
  view(room, index) {
    if (!room.state) return null;
    const view = game.playerView({ ...room.state, board: game.syncBoard(room.state) }, index);
    const paused = this.paused(room);
    return { ...view, revision: room.revision, paused, pauseReason: paused ? '等待三位玩家入座并在线' : null,
      board: view.board ? { ...view.board, paused } : view.board };
  }
  roomMessage(room, extra = {}) {
    return { players: this.players(room), phase: room.phase, options: room.options, isPrivate: !!room.isPrivate,
      paused: this.paused(room), dissolution: this.dissolution(room), ...extra };
  }
  spectatorView(room) {
    if (room.phase !== 'playing' || !room.state) return null;
    // Only publish the explicit public board schema, never the internal state.
    // Keep every hand hidden even during settlement or after the match ends.
    return { ...maskView(game.syncBoard(room.state), -1, {
      keepHiddenAfterWin: true, piles: room.state.phase === 'bidding' ? ['bottomCards'] : []
    }), bidMode: room.state.bidMode, calledPlayers: room.state.calledPlayers,
      passedCall: room.state.passedCall, robAttempts: room.state.robAttempts,
      landlordCandidate: room.state.landlordCandidate, scores: room.state.scores,
      revision: room.revision, paused: this.paused(room) };
  }
  watchMessage(ws, room, type = 'room_watched') {
    this.send(ws, this.roomMessage(room, { type, roomId: room.id, game: 'doudizhu',
      spectator: true, playerIndex: -1, yourTurn: false, state: this.spectatorView(room) }));
  }
  broadcastWatchers(room, type = 'game_state', extra = {}) {
    for (const ws of this.sockets) if (ws.watchRoomId === room.id && ws.readyState === 1 && !ws.revoked) {
      if (type === 'room_dissolved') {
        this.send(ws, { type, roomId: room.id, ...extra }); ws.watchRoomId = null;
      } else this.watchMessage(ws, room, type);
    }
  }
  broadcast(room, type = 'room_update', extra = {}) {
    for (const [ws,p] of room.players) if (online(ws,p)) this.send(ws, this.roomMessage(room, {type, ...extra}));
    this.broadcastWatchers(room, type, extra);
  }
  broadcastState(room, type = 'game_state') {
    this.broadcastWatchers(room, type);
    for (const [ws,p] of room.players) if (online(ws,p)) {
      const state = this.view(room,p.index);
      this.send(ws, this.roomMessage(room, { type, state, match: null, yourTurn: !this.paused(room) && !finished(room) && ['bidding','playing'].includes(state.phase) && state.currentPlayer === p.index }));
    }
  }
  seat(identity) {
    if (!identity) return null;
    for (const room of this.rooms.values()) for (const [ws,info] of room.players) if (info.identityId === identity.id) return { room, ws, info };
    return null;
  }
  electHost(room) {
    if (room.host && room.players.has(room.host) && online(room.host, room.players.get(room.host))) return;
    room.host = [...room.players].find(([ws,p]) => online(ws,p))?.[0] || room.players.keys().next().value || null;
  }
  identify(ws, data) {
    if (ws.identity && this.identities.get(ws.token) === ws.identity) {
      if (data.identityToken !== undefined && data.identityToken !== ws.token) return this.error(ws,'IDENTITY_INVALID','登录已失效，请重新选择用户。');
      return ws.identity;
    }
    let identity;
    if (data.identityToken !== undefined) {
      identity = typeof data.identityToken === 'string' && this.identities.get(data.identityToken);
      if (!identity) return this.error(ws,'IDENTITY_INVALID','登录已失效，请手动重新登录。');
    } else {
      const name = normalizeName(data.name);
      if (!validName(name)) return this.error(ws,'NAME_INVALID','请设置 1–16 个字符的昵称。');
      identity = this.byName.get(nameKey(name)) || { id: crypto.randomUUID(), name, createdAt: Date.now() };
    }
    for (const [token, other] of this.identities) if (other.id === identity.id) this.identities.delete(token);
    for (const other of this.sockets) if (other !== ws && other.identity?.id === identity.id && !other.revoked) {
      other.revoked = true;
      this.send(other,{type:'session_replaced',message:'同一用户已在其他位置登录。'});
      this.effect(() => { try { other.close(1000,'session replaced'); } catch (_) {} });
    }
    ws.identity = identity; ws.token = freshToken();
    this.identities.set(ws.token, identity); this.byName.set(nameKey(identity.name),identity);
    return identity;
  }
  identified(ws) {
    const seat = this.seat(ws.identity);
    this.send(ws,{type:'identified',name:ws.identity.name,userId:ws.identity.id,identityToken:ws.token,roomId:seat?.room.id || null,resumeToken:seat?.info.resumeToken || null});
  }
  joinMessage(ws,room,type) {
    const p = room.players.get(ws);
    this.send(ws,this.roomMessage(room,{type,roomId:room.id,game:'doudizhu',maxPlayers:3,minPlayers:3,playerIndex:p.index,
      state:room.phase === 'playing' ? this.view(room,p.index) : null,match:null,resumeToken:p.resumeToken,identityToken:ws.token,userId:ws.identity.id}));
  }
  remove(ws,room) {
    const info = room.players.get(ws);
    ws.roomId = null;
    if (!info) return;
    room.players.delete(ws); room.readyPlayers.delete(info.index); room.votes.clear();
    if (room.state?.continueVoting?.votes) {
      room.state.continueVoting.votes[info.index] = null;
      room.state.continueVoting.continueYesVotes = room.state.continueVoting.votes.filter(v=>v==='yes').length;
      room.state.continueVoting.continueNoVotes = room.state.continueVoting.votes.filter(v=>v==='no').length;
    }
    this.electHost(room);
    if (room.players.size === 0) {
      this.broadcastWatchers(room, 'room_dissolved', {message:'牌桌已关闭。'});
      this.rooms.delete(room.id);
    }
    else { this.broadcast(room); if (room.phase === 'playing') this.broadcastState(room); }
  }
  disconnect(ws) {
    ws.watchRoomId = null;
    const room = this.rooms.get(ws.roomId), info = room?.players.get(ws);
    if (!info || this.failed) return;
    this.transaction(() => {
      info.disconnectedAt = Date.now(); room.votes.clear();
      this.electHost(room);
      this.broadcast(room,'player_left');
      if (room.phase === 'playing') this.broadcastState(room);
    });
  }
  list() {
    return [...this.rooms.values()].filter(r=>!r.isPrivate).map(r=>({
      roomId:r.id,game:'doudizhu',gameName:'doudizhu',seats:Array.from({length:3},(_,index)=>{
        const entry=[...r.players].find(([,p])=>p.index===index);
        return {index,name:entry?entry[1].name:'',vacant:!entry,online:entry?online(...entry):false};
      }),playerCount:r.players.size,canJoin:r.players.size<3,paused:this.paused(r),
      status:r.phase==='playing'?(this.paused(r)?'paused':finished(r)?'finished':'playing'):r.players.size===3?'full':'waiting',
      humanCount:r.players.size,maxPlayers:3,hostName:r.players.get(r.host)?.name || '',phase:r.phase,createdAt:r.createdAt
    })).sort((a,b)=>b.createdAt-a.createdAt);
  }
  dispatch(ws,msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
    const {type,requestId} = msg;
    const data = msg.data == null ? {} : msg.data;
    if (typeof data !== 'object' || Array.isArray(data)) return this.error(ws,'INVALID_MESSAGE','请求格式不正确。',requestId);
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 80 || !requestId)) return this.error(ws,'INVALID_MESSAGE','请求编号不正确。');
    if (ws.revoked || (ws.identity && this.identities.get(ws.token) !== ws.identity)) return this.error(ws,'IDENTITY_INVALID','此登录已失效，请手动重新登录。',requestId);
    if (type === 'ping') return this.send(ws,{type:'pong',requestId});
    const fingerprint = JSON.stringify([type,data]);
    ws.requests ||= new Map();
    if (requestId && ws.requests.has(requestId)) {
      const previous = ws.requests.get(requestId);
      if (previous.fingerprint !== fingerprint) return this.error(ws,'REQUEST_CONFLICT','同一请求编号不能用于不同操作。',requestId);
      this.send(ws,previous.result); return;
    }
    ws.lastActionError = null;
    const persist = mutationTypes.has(type) && !ws.watchRoomId;
    this.transaction(()=>{
      this.handle(ws,type,data);
      if (requestId) {
        const result = {type:'action_result',requestId,ok:!ws.lastActionError,...(ws.lastActionError || {})};
        this.send(ws,result);
        this.effect(()=>{
          ws.requests.set(requestId,{fingerprint,result});
          if (ws.requests.size>64) ws.requests.delete(ws.requests.keys().next().value);
        });
      }
    },persist);
  }
  handle(ws,type,data) {
    // Watching uses an anonymous, read-only connection: no identity takeover,
    // seat allocation, ready vote or checkpoint write is needed.
    if (type === 'watch_room') {
      if (ws.roomId || this.seat(ws.identity)) return this.error(ws,'ACTIVE_ROOM','请使用独立观战页面，不要中断当前座位。');
      const id = typeof data.roomId === 'string' ? data.roomId.trim().toUpperCase() : '';
      const watched = this.rooms.get(id);
      if (!watched) return this.error(ws,'ROOM_NOT_FOUND','房间不存在。');
      ws.watchRoomId = id;
      return this.watchMessage(ws, watched);
    }
    if (ws.watchRoomId) {
      if (type === 'leave_room') { ws.watchRoomId = null; this.send(ws,{type:'left_room'}); return; }
      if (type === 'get_state') {
        const watched = this.rooms.get(ws.watchRoomId);
        if (watched) return this.watchMessage(ws, watched);
        return this.error(ws,'ROOM_NOT_FOUND','房间不存在。');
      }
      return this.error(ws,'SPECTATOR_READ_ONLY','观战模式不能参与牌局操作。');
    }
    if (['identify','create_room','join_room'].includes(type)) { if (!this.identify(ws,data)) return; }
    else if (!ws.identity) return this.error(ws,'IDENTITY_REQUIRED','请先登录。');
    let room = this.rooms.get(ws.roomId);
    if (room && !room.players.has(ws)) room = null;
    const fail = (code,message) => this.error(ws,code,message);
    if (type === 'identify') return this.identified(ws);
    if (type === 'logout') {
      const identity = ws.identity;
      this.identities.delete(ws.token); this.identities.set(freshToken(),identity);
      // Preserve the nickname and any occupied seat, but revoke this bearer token.
      ws.revoked = true;
      this.send(ws,{type:'logged_out'});
      // Flush the correlated result before beginning the closing handshake.
      this.effect(()=>setImmediate(()=>ws.close(1000,'logged out')));
      return;
    }
    if (type === 'set_name') {
      const name=normalizeName(data.name), existing=this.byName.get(nameKey(name));
      if (!validName(name)) return fail('NAME_INVALID','昵称必须为 1–16 个字符。');
      if (existing && existing.id !== ws.identity.id) return fail('NAME_TAKEN','昵称已被使用。');
      this.byName.delete(nameKey(ws.identity.name)); ws.identity.name=name; this.byName.set(nameKey(name),ws.identity);
      const seat=this.seat(ws.identity);
      if(seat){seat.info.name=name;this.broadcast(seat.room);}
      return this.identified(ws);
    }
    if (['add_bot','remove_bot','kick_player','swap_seat','release_seat'].includes(type)) return fail('ACTION_DISABLED','此牌桌不支持机器人、踢人或自动释放座位。');
    if (type === 'create_room' || type === 'join_room') {
      const seat = this.seat(ws.identity);
      const id = typeof data.roomId === 'string' ? data.roomId.trim().toUpperCase() : '';
      if (seat && (type === 'create_room' || id !== seat.room.id)) return fail('ACTIVE_ROOM','你仍在另一张牌桌，请先返回并离桌。');
      if(type === 'create_room') {
        if(data.game !== 'doudizhu') return fail('INVALID_GAME','无效的游戏类型');
        const options={bidMode:'score',playTimeLimit:0,totalRounds:3};
        if(data.options != null && (typeof data.options !== 'object' || Array.isArray(data.options))) return fail('OPTION_INVALID','房间设置不正确。');
        if(data.options){
          const rounds=data.options.totalRounds ?? data.options.maxRounds;
          if(rounds !== undefined && (!Number.isInteger(rounds)||rounds<1||rounds>30))return fail('OPTION_INVALID','局数必须是 1–30。');
          if(rounds !== undefined) options.totalRounds=rounds;
          if(data.options.bidMode !== undefined && !['score','rob'].includes(data.options.bidMode))return fail('OPTION_INVALID','叫地主方式不正确。');
          if(data.options.bidMode)options.bidMode=data.options.bidMode;
        }
        let id;
        do { id=Array.from(crypto.randomBytes(4),b=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b%31]).join(''); } while(this.rooms.has(id));
        room={id,game:'doudizhu',maxPlayers:3,lang:'zh',phase:'lobby',state:null,options,isPrivate:false,createdAt:Date.now(),revision:0,readyPlayers:new Set(),players:new Map(),votes:new Set(),host:ws};
        this.rooms.set(id,room);
      } else {
        room=this.rooms.get(id);
        if(!room)return fail('ROOM_NOT_FOUND','房间不存在。');
        if(!seat && room.players.size>=3)return fail('GAME_STARTED','牌桌已满。');
      }
      const old=this.seat(ws.identity);
      let info;
      if(old && old.room===room){
        info=old.info;room.players.delete(old.ws);if(room.host===old.ws)room.host=ws;
        info.disconnectedAt=null;info.name=ws.identity.name;
      }else{
        const occupied=new Set([...room.players.values()].map(p=>p.index));
        const index=[0,1,2].find(i=>!occupied.has(i));
        info={index,name:ws.identity.name,identityId:ws.identity.id,avatar:'😊',resumeToken:crypto.randomUUID(),disconnectedAt:null};
      }
      room.players.set(ws,info);ws.roomId=room.id;room.votes.clear();this.electHost(room);
      this.joinMessage(ws,room,type==='create_room'?'room_created':'room_joined');
      this.broadcast(room);if(room.phase==='playing')this.broadcastState(room);
      return;
    }
    if (type==='leave_room') { if(room)this.remove(ws,room);this.send(ws,{type:'left_room'});return; }
    if (!room) return fail('NOT_IN_ROOM','请先入座。');
    const info=room.players.get(ws);
    if (type==='get_state') return this.joinMessage(ws,room,'room_joined');
    if (type==='player_ready') {
      if(room.phase==='playing')return fail('GAME_STARTED','牌局已开始。');
      const ready=typeof data.ready==='boolean'?data.ready:!room.readyPlayers.has(info.index);
      if(ready)room.readyPlayers.add(info.index);else room.readyPlayers.delete(info.index);
      room.phase=room.readyPlayers.size?'ready':'lobby';return this.broadcast(room);
    }
    if (type==='set_avatar') {
      const avatar=typeof data.avatar==='string'?data.avatar.replace(/[<>&"'`\u0000-\u001f\u007f]/g,'').trim():'';
      if(!avatar || avatar.length>4)return fail('AVATAR_INVALID','头像不正确。');
      info.avatar=avatar;return this.broadcast(room);
    }
    if (type==='set_option' || type==='set_private') {
      if(room.host!==ws)return fail('HOST_ONLY','只有房主可以修改设置。');
      if(room.phase==='playing')return fail('GAME_STARTED','牌局中不能修改设置。');
      const key=type==='set_private'?'isPrivate':data.key,value=type==='set_private'?data.isPrivate:data.value;
      if(['totalRounds','maxRounds'].includes(key)){
        if(!Number.isInteger(value)||value<1||value>30)return fail('OPTION_INVALID','局数必须是 1–30。');
        room.options.totalRounds=value;
      }else if(key==='isPrivate')room.isPrivate=room.options.isPrivate=!!value;
      else if(key==='bidMode' && ['score','rob'].includes(value))room.options.bidMode=value;
      else return fail('OPTION_INVALID','不支持的设置。');
      return this.broadcast(room);
    }
    if (type==='start_game' || type==='game_restart') {
      if(room.host!==ws)return fail('HOST_ONLY','只有房主可以开始。');
      if(type==='start_game' && room.phase==='playing')return fail('GAME_STARTED','牌局已开始。');
      if(type==='game_restart' && !finished(room))return fail('GAME_IN_PROGRESS','牌局尚未结束，不能重新发牌。');
      if(room.players.size!==3)return fail('PLAYERS_REQUIRED','需要三位玩家入座。');
      if([...room.players].some(([w,p])=>!online(w,p)))return fail('PLAYERS_OFFLINE','请等待所有玩家在线。');
      if(type==='start_game' && [...room.players.values()].some(p=>!room.readyPlayers.has(p.index)))return fail('READY_REQUIRED','请等待所有玩家准备。');
      // A new match on the same table keeps its accumulated score and round history.
      const previous=room.state;
      room.state=game.createState();room.state._options={...room.options};room.state._playerCount=3;room.state._realPlayerCount=3;room.state._hasBots=false;room.state._lang='zh';
      game.initGame(room.state,3);
      if(previous?.cumulativeScore){room.state.cumulativeScore=previous.cumulativeScore.slice();room.state.roundHistory=(previous.roundHistory||[]).slice();}
      room.phase='playing';room.revision++;return this.broadcastState(room,'game_started');
    }
    if(type==='request_restart'){
      if(room.host && room.host!==ws)this.send(room.host,{type:'restart_requested',by:info.name});
      return;
    }
    if(type==='return_to_room'){
      if(room.phase==='playing' && !finished(room))return fail('GAME_IN_PROGRESS','牌局尚未结束。');
      room.phase='lobby';room.readyPlayers.clear();return this.broadcast(room);
    }
    if(type==='game_move'){
      if(room.phase!=='playing' || !room.state)return fail('game_not_playing','牌局尚未开始。');
      if(this.paused(room))return fail('GAME_PAUSED','牌局已暂停，请等待三位玩家入座并在线。');
      if(data.expectedRevision!==undefined && data.expectedRevision!==room.revision){this.broadcastState(room);return fail('STALE_STATE','牌局已更新，请按最新状态重试。');}
      const error=game.handleMove(data,room.state,info.index);
      if(error)return fail(error);
      room.revision++;return this.broadcastState(room);
    }
    if(type==='dissolve_vote'){
      if(!this.dissolution(room).eligible)return fail('DISSOLVE_UNAVAILABLE','需要一位玩家离线至少 120 秒，另两位在线共同同意。');
      if(data.agree===true)room.votes.add(info.index);else room.votes.delete(info.index);
      const voters=[...room.players].filter(([w,p])=>online(w,p)).map(([,p])=>p.index);
      if(voters.every(index=>room.votes.has(index))){
        this.broadcast(room,'room_dissolved',{reason:'offline_vote',scores:room.state?.cumulativeScore || [],message:'两位在线玩家同意解散，未完成局不计分。'});
        for(const client of room.players.keys())client.roomId=null;
        this.rooms.delete(room.id);
      }else this.broadcast(room);
      return;
    }
    fail('ACTION_DISABLED','不支持的操作。');
  }
}
module.exports = { Tables, normalizeName, nameKey };
