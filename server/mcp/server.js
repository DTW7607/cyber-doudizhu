'use strict';
// Modified 2026-11-12: landlord-only ordinary-player tools; no strategy/bot tools; local-only MCP.
// GameNest MCP server: lets an AI agent play GameNest as a normal player seat.
// stdout is reserved for the MCP stdio transport; all logs go to stderr.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WebSocket = require('ws');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const guides = require('./move-guides');

const ROOT = path.resolve(__dirname, '..');
const URL_BASE = process.env.GAMENEST_URL || 'ws://localhost:3000';
const log = (...a) => console.error('[gamenest-mcp]', ...a);

// ---------- game metadata ----------
function loadCatalog() {
  try {
    const w = {};
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/js/game-catalog.js'), 'utf8'), { window: w, document: {}, navigator: {} });
    return w.gameCatalog || {};
  } catch (e) { return {}; }
}
function listGames() {
  const catalog = loadCatalog();
  return fs.readdirSync(path.join(ROOT, 'games'))
    .filter((f) => f === 'doudizhu.js')
    .map((f) => f.replace(/\.js$/, ''))
    .map((id) => {
      let mod = {};
      try { mod = require(path.join(ROOT, 'games', id)); } catch (e) { /* ignore */ }
      const c = catalog[id] || {};
      return {
        id, name: c.name || id,
        minPlayers: mod.minPlayers || 2, maxPlayers: mod.maxPlayers || c.maxPlayers || 2,
        hasBot: false,
        realtime: !!mod.realtime,
      };
    });
}
const gameMod = (id) => { try { return require(path.join(ROOT, 'games', id)); } catch (e) { return null; } };

// ---------- session (one WebSocket per process) ----------
const S = {
  identityToken: process.env.GAMENEST_IDENTITY_TOKEN || undefined, name: null, dissolution: null, ws: null, roomId: null, game: null, mySeat: null, resumeToken: null,
  phase: null, players: [], options: {}, match: null, state: null,
  seq: 0,            // increments on every state broadcast
  lastError: null,   // {seq, message, code, at}
  leaving: false, reconnecting: false, revoked: false, paused: false,
};
const listeners = new Set();
const acknowledgements = new Map();
let requestNumber = 0, connecting = null;
const notify = () => { for (const f of Array.from(listeners)) f(); };
const resetRoom = () => { S.match = null; S.roomId = null; S.resumeToken = null; S.state = null; S.phase = null; S.mySeat = null; S.game = null; S.players = []; S.paused = false; };

function connect() {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) return Promise.resolve();
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_BASE);
    const t = setTimeout(() => { try { ws.terminate(); } catch (e) { /* ignore */ } reject(new Error('connect timeout: ' + URL_BASE)); }, 8000);
    ws.on('open', () => { clearTimeout(t); S.ws = ws; resolve(); });
    ws.on('error', (e) => { clearTimeout(t); log('ws error', e.message); reject(new Error('cannot connect to ' + URL_BASE + ': ' + e.message)); });
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; } onMessage(m); });
    ws.on('close', () => {
      if (S.ws !== ws) return;
      S.ws = null; S.paused = true; notify();
      if (S.roomId && S.resumeToken && !S.leaving && !S.revoked) autoResume();
    });
  }).finally(() => { connecting = null; });
  return connecting;
}

// Reconnect with the resume token (same mechanism as public/js/room-client.js).
async function autoResume() {
  if (S.reconnecting || S.revoked) return;
  S.reconnecting = true;
  for (let i = 0; i < 10 && !S.leaving && !S.revoked && S.roomId; i++) {
    await new Promise((r) => setTimeout(r, 1000 * Math.min(i + 1, 5)));
    try {
      await connect();
      const result = await sendAndWait('join_room', {roomId:S.roomId,identityToken:S.identityToken,lang:'zh'}, null, 4000);
      if (!result.ok) throw new Error(result.error);
      log('resumed room', S.roomId);
      break;
    } catch (e) { log('resume attempt failed', e.message); }
  }
  S.reconnecting = false;
}

function applyRoomInfo(m) {
  if (m.identityToken) { S.identityToken = m.identityToken; S.revoked = false; if(S.ws)S.ws._identified=true; }
  if (typeof m.paused === 'boolean') S.paused = m.paused;
  if (m.dissolution !== undefined) S.dissolution = m.dissolution;
  if (m.roomId) S.roomId = m.roomId;
  if (m.game) S.game = m.game;
  if (typeof m.playerIndex === 'number') S.mySeat = m.playerIndex;
  if (m.resumeToken) S.resumeToken = m.resumeToken;
  if (m.phase) S.phase = m.phase;
  if (m.players) S.players = m.players;
  if (m.options) S.options = m.options;
  if ('match' in m) S.match = m.match;
  if ('state' in m && m.state) { S.state = m.state; S.seq++; }
}

// drawguess strokes arrive as deltas on the current canvas instead of a full game_state
function applyDelta(d) {
  const task = S.state && S.state.myTask;
  if (!d || !task || !Array.isArray(task.strokes)) return;
  if (d.op === 'stroke' && d.stroke) task.strokes.push(d.stroke);
  else if (d.op === 'trim') task.strokes.length = Math.min(task.strokes.length, d.n || 0);
  S.seq++;
}

function onMessage(m) {
  if (m.type === 'action_result') { acknowledgements.set(m.requestId,m); notify(); return; }
  if (m.type === 'room_update') S.seq++;
  switch (m.type) {
    case 'identified': S.identityToken = m.identityToken; S.name = m.name; S.revoked = false; applyRoomInfo(m); break;
    case 'session_replaced':
      S.revoked = true; S.identityToken = undefined; S.name = null; S.leaving = true; resetRoom();
      S.lastError = {seq:S.seq, message:'Logged in elsewhere. Explicitly identify to log in again.', code:'SESSION_REPLACED', at:Date.now()};
      break;
    case 'room_dissolved': resetRoom(); break;
    case 'room_created': S.match = null; applyRoomInfo(m); break; // fresh room: drop the previous room's match
    case 'game_started': applyRoomInfo(m); S.phase = 'playing'; break;
    case 'game_state': applyRoomInfo(m); if (m.state) S.phase = 'playing'; break;
    case 'game_delta': applyDelta(m.delta); break;
    case 'player_index_updated': S.mySeat = m.playerIndex; break;
    case 'left_room': case 'kicked': resetRoom(); break;
    case 'error':
      if (m.requestId) acknowledgements.set(m.requestId,{ok:false,message:m.message,code:m.code});
      if (m.code === 'IDENTITY_INVALID') { S.revoked = true; S.identityToken = undefined; S.name = null; S.leaving = true; resetRoom(); }
      S.lastError = { seq: S.seq, message: m.message, code: m.code || null, at: Date.now() }; break;
    default: applyRoomInfo(m);
  }
  if (m.type === 'room_update' && m.phase === 'lobby') S.state = null;
  notify();
}

async function connectAndSend(type, data) {
  await connect();
  S.ws.send(JSON.stringify({ type, data: data || {} }));
}

// Correlate each result with its request, never with another player's broadcast.
async function sendAndWait(type, data, pred, ms) {
  await connect();
  if (!['identify','create_room','join_room'].includes(type) && !S.ws._identified && S.identityToken) {
    const restored = await sendAndWait(S.roomId ? 'join_room' : 'identify', {roomId:S.roomId,identityToken:S.identityToken}, null, 4000);
    if (!restored.ok) return restored;
  }
  S.lastError = null;
  const requestId = 'mcp-' + (++requestNumber);
  const body = type === 'game_move' ? {...data, expectedRevision:S.state?.revision} : (data || {});
  return new Promise(resolve => {
    const done = result => { clearTimeout(timer); listeners.delete(check); acknowledgements.delete(requestId); resolve(result); };
    const check = () => {
      const ack = acknowledgements.get(requestId);
      if (ack) return done(ack.ok ? {ok:true} : {ok:false,error:ack.message,code:ack.code});
      if (S.revoked) done({ok:false,error:'Session replaced. Explicitly identify again.',code:'SESSION_REPLACED'});
    };
    const timer = setTimeout(() => done({ok:false,unconfirmed:true,error:'No server acknowledgement; inspect state before retrying.'}), ms || 4000);
    listeners.add(check);
    try { S.ws.send(JSON.stringify({type,data:body,requestId})); }
    catch (_) { done({ok:false,unconfirmed:true,error:'Connection lost; inspect state before retrying.'}); }
  });
}

// ---------- derived info ----------
// mahjong-style games end with phase 'over' + winners[] and leave state.winner unset
const isOver = (st) => !!st && ((st.winner !== null && st.winner !== undefined) || st.phase === 'over');
function actorInfo() {
  const st = S.state;
  if (!st || S.phase !== 'playing') return { currentActor: null, pendingActors: null, isMyTurn: false, over: false };
  const gm = S.game && gameMod(S.game);
  let actor = st.currentPlayer;
  try { if (gm && gm.getCurrentActor) actor = gm.getCurrentActor(st); } catch (e) { /* ignore */ }
  let pending = null;
  try { if (gm && gm.getPendingActors) pending = gm.getPendingActors(st); } catch (e) { /* ignore */ }
  const over = isOver(st);
  let mine;
  if (Array.isArray(pending)) mine = pending.indexOf(S.mySeat) >= 0;
  else if (Number.isInteger(actor) && actor >= 0) mine = actor === S.mySeat;
  else mine = true; // currentPlayer -1/null: simultaneous or race game (2048, sudoku, minesweeper...)
  if (st.phase === 'round_end' || st.phase === 'roundEnd') mine = false; // twentyfour: the server starts the next round itself
  return { currentActor: Number.isInteger(actor) ? actor : null, pendingActors: pending, isMyTurn: !over && !S.paused && !st.paused && !!mine, over };
}
function snapshot(includeState) {
  const a = actorInfo();
  const out = {
    connected: !!(S.ws && S.ws.readyState === WebSocket.OPEN),
    roomId: S.roomId, game: S.game, mySeat: S.mySeat, phase: S.phase,
    isHost: !!S.players.find((p) => p.index === S.mySeat && p.isHost),
    players: S.players, dissolution: S.dissolution, options: S.options, match: S.match,
    seq: S.seq, currentActor: a.currentActor, pendingActors: a.pendingActors,
    isMyTurn: a.isMyTurn, gameOver: a.over, paused: !!(S.paused || S.state?.paused), sessionReplaced: S.revoked,
    winner: S.state ? (S.state.winner === undefined ? null : S.state.winner) : null,
    lastError: S.lastError ? S.lastError.message : null,
  };
  if (includeState) out.state = S.state;
  return out;
}

// ---------- MCP ----------
const server = new McpServer({ name: 'gamenest', version: '1.0.0' });
const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });
const ENABLED_TOOLS = new Set(['list_games','get_rules','create_room','join_room','set_option','ready','start_game','get_state','wait_for_turn','make_move','restart','next_round','return_to_room','send_message','leave_room','identify','list_rooms','dissolve_vote']);
const tool = (name, description, schema, fn) => ENABLED_TOOLS.has(name) && server.registerTool(name, { description, inputSchema: schema }, async (args) => {
  try { return text(await fn(args || {})); } catch (e) { return { isError: true, content: [{ type: 'text', text: String((e && e.message) || e) }] }; }
});
const needRoom = () => { if (!S.roomId) throw new Error('not in a room: call create_room or join_room first'); };
const roomAction = (type, label, mk) => async (args) => {
  needRoom();
  const r = await sendAndWait(type, mk ? mk(args) : {}, null, 1500);
  if (!r.ok) throw new Error(r.error);
  return Object.assign({ done: label }, snapshot(false));
};

tool('identify', 'Create or resume a normal player identity. Same nickname rules as the browser. 身份识别。', {name:z.string().max(16).optional()}, async ({name}) => {
  if (S.revoked && !name) throw new Error('Session replaced. Provide name to explicitly log in again.');
  if (S.revoked && S.ws) { const old = S.ws; S.ws = null; old.close(); }
  S.leaving = false;
  const r = await sendAndWait('identify', {name,identityToken:S.identityToken}, () => !!S.identityToken && !!S.name, 3000);
  if (!r.ok || r.unconfirmed) throw new Error(r.error || 'identity not confirmed');
  return {name:S.name, identified:true};
});
tool('list_rooms', 'List public rooms including full and playing rooms. 列出所有公共房间。', {}, async () => {
  const url = new URL('/api/rooms', URL_BASE.replace(/^ws/, 'http'));
  const response = await fetch(url, {signal:AbortSignal.timeout(8000)}); if (!response.ok) throw new Error('room list unavailable'); return response.json();
});
tool('dissolve_vote', 'Vote to dissolve only after a player is offline for 120 seconds. Both other online players must agree. 解散投票。', {agree:z.boolean()}, roomAction('dissolve_vote','vote recorded',({agree})=>({agree})));

tool('list_games', 'List available games: id, name, min/max players, whether a built-in bot exists. 列出可玩的游戏。', {}, async () => listGames());

tool('get_rules', 'Get the move JSON format and an example for a game. 获取某游戏的出招格式。', { game: z.string() }, async ({ game }) => {
  if (game !== 'doudizhu' || !guides[game]) throw new Error('unknown game: ' + game);
  return { game, moveGuide: guides[game], note: 'Operation formats only. Inspect get_state().state and act as an ordinary player. No strategy recommendations.' };
});

tool('create_room', 'Create a room for a game and become the host (seat 0). 创建房间。', { game: z.literal('doudizhu'), name: z.string().max(16).optional() }, async ({ game, name }) => {
  if (S.revoked) throw new Error('Session replaced: call identify with a name first.');
  S.leaving = false;
  const r = await sendAndWait('create_room', { game, name, identityToken: S.identityToken, lang: 'zh' }, () => !!S.roomId && S.game === game, 3000);
  if (!r.ok || r.unconfirmed) throw new Error(r.error || 'create_room failed (no response)');
  return snapshot(false);
});

tool('join_room', 'Join an existing room by room id (shown in the browser). 加入房间。', { roomId: z.string(), name: z.string().max(16).optional() }, async ({ roomId, name }) => {
  if (S.revoked) throw new Error('Session replaced: call identify with a name first.');
  S.leaving = false;
  const id = roomId.toUpperCase();
  const r = await sendAndWait('join_room', { roomId: id, name, identityToken: S.identityToken, lang: 'zh' }, () => S.roomId === id, 3000);
  if (!r.ok || r.unconfirmed) throw new Error(r.error || 'join_room failed (no response)');
  return snapshot(false);
});

tool('add_bot', 'Host only, before start: add a built-in bot to the next free seat. 添加电脑玩家。', {}, roomAction('add_bot', 'add_bot'));
tool('remove_bot', 'Host only, before start: remove the bot at a seat. 移除电脑。', { seat: z.number().int() }, roomAction('remove_bot', 'remove_bot', ({ seat }) => ({ botIndex: seat })));
tool('set_option', 'Host only, before start: set a room option (e.g. key totalRounds, value 3). 设置房间选项。', { key: z.string(), value: z.any() }, roomAction('set_option', 'set_option', ({ key, value }) => ({ key, value })));
tool('ready', 'Toggle my ready flag. Every human must be ready before start_game. 准备/取消准备。', {}, roomAction('player_ready', 'ready toggled'));

tool('start_game', 'Host only: start the game (all humans ready, enough seats). 开始游戏。', {}, async () => {
  needRoom();
  const r = await sendAndWait('start_game', {}, () => S.phase === 'playing' && !!S.state, 3000);
  if (!r.ok) throw new Error(r.error);
  return snapshot(true);
});

tool('get_state', 'Latest game state as seen by my seat, plus mySeat, currentActor, isMyTurn, winner, players, seq. 获取当前局面。', {}, async () => snapshot(true));

tool('wait_for_turn', 'Wait for my turn, game/round end, pause, disconnection or session replacement (default 60s, max 120s). 等待回合或状态变化。', {
  timeoutSec: z.number().min(1).max(120).optional(),
}, async ({ timeoutSec }) => {
  const ms = Math.min(timeoutSec || 60, 120) * 1000;
  const roundEnd = () => !!S.state && ['round_end','roundEnd'].includes(S.state.phase);
  const ready = () => { const a = actorInfo(); return a.over || a.isMyTurn || roundEnd() || !S.roomId || S.paused || !S.ws || S.ws.readyState !== WebSocket.OPEN; };
  if (!ready()) {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(t); listeners.delete(fn); resolve(); };
      const fn = () => { if (ready()) done(); };
      const t = setTimeout(done, ms);
      listeners.add(fn);
    });
  }
  const snap = snapshot(true);
  snap.reason = snap.gameOver ? 'game_over' : snap.isMyTurn ? 'my_turn' : roundEnd() ? 'round_end' : 'timeout';
  if (S.revoked) snap.reason = 'session_replaced';
  else if (!snap.connected) snap.reason = 'disconnected';
  else if (snap.paused) snap.reason = 'paused';
  if (snap.reason === 'round_end') snap.hint = 'Round finished: call next_round to start the next one.';
  return snap;
});

tool('make_move', 'Send a game move object (see get_rules). Optional expectSeq (seq from get_state) rejects stale moves. 出招。', {
  move: z.record(z.string(), z.any()),
  expectSeq: z.number().int().optional(),
}, async ({ move, expectSeq }) => {
  needRoom();
  if (typeof expectSeq === 'number' && expectSeq !== S.seq) {
    return { ok: false, stale: true, error: 'state changed since seq ' + expectSeq, seq: S.seq };
  }
  const r = await sendAndWait('game_move', move, null, 2000);
  const a = actorInfo();
  return Object.assign({}, r, { seq: S.seq, isMyTurn: a.isMyTurn, gameOver: a.over });
});

// ---------- drawguess: see and draw the canvas ----------
const canvasStrokes = () => { const st = S.state; return (st && (st.strokes || (st.myTask && st.myTask.strokes))) || []; };
tool('restart', 'Host: restart the game after it ends; non-host: ask the host to restart. 重新开始。', {}, async () => {
  needRoom();
  const isHost = snapshot(false).isHost;
  const r = await sendAndWait(isHost ? 'game_restart' : 'request_restart', {}, isHost ? null : () => true, 2500);
  if (!r.ok) throw new Error(r.error);
  return snapshot(true);
});
tool('next_round', 'Advance from roundEnd to the next scheduled round. 下一局。', {}, async () => {
  needRoom();
  const r = await sendAndWait('game_move', {action:'next_round'}, null, 2000);
  if (!r.ok) throw new Error(r.error);
  return snapshot(true);
});
tool('return_to_room', 'Go back to the room lobby after a game. 回到房间大厅。', {}, roomAction('return_to_room', 'return_to_room'));

// The remaining room messages the browser client can send (drawguess strokes/guesses go through make_move).
const EXTRA = ['set_avatar', 'set_name'];
tool('send_message', 'Update my avatar or nickname: set_avatar {avatar}, set_name {name}. 修改自己的头像或昵称。', {
  type: z.enum(EXTRA),
  data: z.record(z.string(), z.any()).optional(),
}, async ({ type, data }) => {
  needRoom();
  const r = await sendAndWait(type, data || {}, () => false, 800);
  if (!r.ok) throw new Error(r.error);
  return Object.assign({ sent: type }, snapshot(false));
});

tool('leave_room', 'Leave the current room and give up the seat. 离开房间。', {}, async () => {
  S.leaving = true;
  if (S.roomId) {
    const r = await sendAndWait('leave_room', {}, () => !S.roomId, 2000);
    if (!r.ok || r.unconfirmed) { S.leaving = false; throw new Error(r.error || 'leave_room not confirmed'); }
  }
  resetRoom();
  return { left: true };
});

// Transport: stdio by default (Claude, Cursor, Codex, Gemini CLI... all spawn it as a subprocess).
// `--http[=port]` or MCP_HTTP_PORT serves the same tools over Streamable HTTP at /mcp for any other MCP client
// or a remote agent. Bound to 127.0.0.1 unless MCP_HTTP_HOST says otherwise; there is no auth, so keep it local.
const httpArg = process.argv.find((a) => a === '--http' || a.startsWith('--http='));
const httpPort = httpArg ? Number(httpArg.split('=')[1] || process.env.MCP_HTTP_PORT || 3333) : Number(process.env.MCP_HTTP_PORT || 0);

async function startHttp(port) {
  const http = require('http');
  // Node 18 has no global Web Crypto by default; the SDK's HTTP transport calls crypto.randomUUID().
  if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const host = '127.0.0.1'; // Never expose this single-seat unauthenticated adapter publicly.
  let chain = Promise.resolve(); // one transport is attached to the shared server at a time
  const handle = async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); });
    await server.connect(transport);
    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { body = undefined; }
    }
    await transport.handleRequest(req, res, body);
  };
  http.createServer((req, res) => {
    if (!req.url.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    // MCP spec: validate Origin to block DNS-rebinding from web pages. Non-browser clients send none.
    const origin = req.headers.origin;
    if (origin) { let h = ''; try { h = new URL(origin).hostname; } catch (e) {} if (!['localhost', '127.0.0.1', '[::1]'].includes(h)) { res.writeHead(403).end(); return; } }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; } // stateless: no server-push stream
    chain = chain.then(() => handle(req, res)).catch((e) => {
      log('http error', e.message);
      if (!res.headersSent) res.writeHead(500).end();
    });
  }).listen(port, host, () => log('Streamable HTTP on http://' + host + ':' + port + '/mcp'));
}

(async () => {
  if (httpPort) await startHttp(httpPort);
  else await server.connect(new StdioServerTransport());
  log('ready, GAMENEST_URL=' + URL_BASE);
})().catch((e) => { log('fatal', e); process.exit(1); });
process.on('SIGTERM', () => process.exit(0));
