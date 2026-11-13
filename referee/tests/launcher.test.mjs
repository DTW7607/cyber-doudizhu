import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launch, validate } from '../start.mjs';
import { invoke, unwrap } from '../mcp-client.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = { matchId: 'integration', players: ['测试甲', '测试乙', '测试丙'], summaryEvery: 5, totalRounds: 30, serverUrl: 'ws://127.0.0.1:3000' };

test('配置拒绝重名、路径越界和无效局数', () => {
  assert.throws(() => validate({ ...base, players: ['ABC', 'abc', '丙'] }), /不同/);
  assert.throws(() => validate({ ...base, matchId: '../private' }), /matchId/);
  assert.throws(() => validate({ ...base, players: ['甲/乙', '乙', '丙'] }), /选手名/);
  assert.throws(() => validate({ ...base, totalRounds: 31 }), /1–30/);
  assert.throws(() => validate({ ...base, summaryEvery: 0 }), /正整数/);
});

test('三席 MCP 预检、首次接入、同桌操作、会话隔离及退出', { timeout: 45000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'referee-test-'));
  await fs.copyFile(path.join(ROOT, '游戏要求模板.md'), path.join(root, '游戏要求模板.md'));
  const server = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', GAMENEST_STATE_FILE: path.join(root, 'server-state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let running;
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('本地游戏服务启动超时')), 8000);
      server.stdout.on('data', data => {
        output += data;
        const match = output.match(/listening on port (\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', () => { clearTimeout(timer); reject(new Error('本地游戏服务提前退出')); });
    });
    const config = { ...base, serverUrl: `ws://127.0.0.1:${port}` };
    running = await launch(config, { root });
    assert.equal(running.manifest.status, 'ready');
    const players = running.manifest.players;
    assert.equal(new Set(players.map(p => p.pid)).size, 3);
    assert.equal(new Set(players.map(p => p.endpoint)).size, 3);
    const lobby = await fetch(`http://127.0.0.1:${port}/api/rooms`).then(r => r.json());
    assert.equal(lobby.rooms.length, 0, '预检不应创建线上身份或房间');
    for (const p of players) {
      const prompt = await fs.readFile(p.instructions, 'utf8');
      assert.ok(prompt.includes(p.endpoint));
      assert.ok(prompt.includes('本次共 30 局'));
      assert.ok(!/\{(?:name|num|totalRounds|agentDir|mcpCall|role|mcpEndpoint|serverUrl)\}/.test(prompt));
      for (const other of players) if (other !== p) assert.ok(!prompt.includes(other.endpoint));
      const config = JSON.parse(await fs.readFile(path.join(p.directory, 'mcp.json'), 'utf8'));
      assert.equal(config.mcpServers.landlord.url, p.endpoint);
    }
    const call = async (i, name, args = {}) => unwrap(await invoke(players[i].endpoint, name, args));
    for (let i = 0; i < 3; i++) assert.equal((await call(i, 'identify', { name: players[i].name })).name, players[i].name);
    const room = await call(0, 'create_room', { game: 'doudizhu' });
    await call(0, 'set_option', { key: 'totalRounds', value: 30 });
    for (const i of [1, 2]) await call(i, 'join_room', { roomId: room.roomId });
    // 每次 CLI 新建 MCP 客户端，但共用本人服务中的同一玩家会话。
    const cli = await exec(process.execPath, [path.join(ROOT, 'referee/mcp-call.mjs'), players[1].endpoint, 'get_state']);
    assert.equal(unwrap(JSON.parse(cli.stdout)).mySeat, 1);
    for (let i = 0; i < 3; i++) await call(i, 'ready');
    await call(0, 'start_game');
    for (let i = 0; i < 3; i++) {
      const snap = await call(i, 'get_state');
      assert.equal(snap.mySeat, i);
      assert.equal(snap.roomId, room.roomId);
      assert.equal(snap.options.totalRounds, 30);
      assert.equal(snap.state.hands[i].length, 17);
      snap.state.hands.forEach((hand, j) => { if (j !== i) assert.ok(hand.every(card => card === null)); });
      assert.ok(!JSON.stringify(snap).includes('identityToken'));
      const stale = await call(i, 'make_move', { move: { score: 0 }, expectSeq: -1 });
      assert.equal(stale.stale, true);
    }
    await assert.rejects(() => launch(config, { root }), /EEXIST/);
    await running.stop();
    const manifest = JSON.parse(await fs.readFile(path.join(running.runtime, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'stopped');
    for (const p of players) {
      const listening = await new Promise(resolve => {
        const socket = net.connect(Number(new URL(p.endpoint).port), '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
      });
      assert.equal(listening, false);
    }
  } finally {
    await running?.stop();
    if (server.exitCode === null && server.signalCode === null) {
      const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('远端不可达时清理已启动的全部 MCP', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'referee-failure-'));
  await fs.copyFile(path.join(ROOT, '游戏要求模板.md'), path.join(root, '游戏要求模板.md'));
  try {
    await assert.rejects(() => launch({ ...base, serverUrl: 'ws://127.0.0.1:1' }, { root }));
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'runtime/integration/manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'stopped');
    for (const player of manifest.players) assert.throws(() => process.kill(player.pid, 0), /ESRCH/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
