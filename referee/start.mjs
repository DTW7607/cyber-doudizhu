#!/usr/bin/env node
// 裁判启动公共接入设施；每个选手独立进程、独立玩家会话。
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withClient, unwrap } from './mcp-client.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REQUIRED = ['identify', 'list_rooms', 'create_room', 'join_room', 'set_option', 'ready', 'start_game', 'get_state', 'wait_for_turn', 'make_move', 'next_round'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function validate(config) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(config.matchId || '')) throw new Error('matchId 须为 1–64 位英文小写、数字、下划线或连字符');
  if (!Array.isArray(config.players) || config.players.length !== 3) throw new Error('必须指定三名选手');
  const names = config.players.map(name => {
    if (typeof name !== 'string' || !/^[\p{L}\p{N}_-]{1,16}$/u.test(name)) throw new Error('选手名限 1–16 位文字、数字、下划线或连字符');
    return name.normalize('NFKC').toLowerCase();
  });
  if (new Set(names).size !== 3) throw new Error('选手名规范化后必须不同');
  if (!Number.isInteger(config.summaryEvery) || config.summaryEvery < 1) throw new Error('summaryEvery 必须为正整数');
  if (!Number.isInteger(config.totalRounds) || config.totalRounds < 1 || config.totalRounds > 30) throw new Error('totalRounds 必须为 1–30');
  const url = new URL(config.serverUrl);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('serverUrl 须为无凭据的 ws/wss URL');
  return config;
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function launch(config, { root = ROOT } = {}) {
  validate(config);
  const runtime = path.join(root, 'runtime', config.matchId);
  await fs.mkdir(path.dirname(runtime), { recursive: true });
  await fs.mkdir(runtime); // 不覆盖已有比赛、身份会话或记录。
  const children = [];
  const manifest = { ...config, status: 'starting', players: [], startedAt: new Date().toISOString() };
  let stopping;
  const save = () => fs.writeFile(path.join(runtime, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const stop = () => stopping ||= (async () => {
    manifest.status = 'stopped';
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(timer); }
    }));
    await save();
  })();
  try {
    const template = await fs.readFile(path.join(root, '游戏要求模板.md'), 'utf8');
    for (const [index, name] of config.players.entries()) {
      const port = await freePort();
      const endpoint = `http://127.0.0.1:${port}/mcp`;
      const log = await fs.open(path.join(runtime, `mcp-${index + 1}.log`), 'wx', 0o600);
      // 身份令牌与 HTTP 端口不从父进程继承，防止三席意外共用身份。
      const env = { ...process.env, GAMENEST_URL: config.serverUrl };
      delete env.GAMENEST_IDENTITY_TOKEN;
      delete env.MCP_HTTP_PORT;
      const child = spawn(process.execPath, [path.join(ROOT, 'server/mcp/server.js'), `--http=${port}`], {
        env, stdio: ['ignore', log.fd, log.fd],
      });
      children.push(child);
      let spawnError;
      child.on('error', error => { spawnError = error; });
      await log.close();
      let tools;
      for (let attempt = 0; attempt < 50; attempt++) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} 的 MCP 提前退出；检查 mcp-${index + 1}.log`);
        try {
          tools = await withClient(endpoint, async client => {
            const result = await client.listTools();
            const names = result.tools.map(tool => tool.name);
            if (REQUIRED.some(tool => !names.includes(tool))) throw new Error('MCP 缺少必要工具');
            unwrap(await client.callTool({ name: 'get_rules', arguments: { game: 'doudizhu' } }));
            return result.tools;
          });
          break;
        } catch { await sleep(100); }
      }
      if (!tools) throw new Error(`${name} 的 MCP 健康检查失败`);
      const directory = path.join(root, 'agents', name, config.matchId);
      await fs.mkdir(directory, { recursive: true });
      const call = `node ${quote(path.join(ROOT, 'referee/mcp-call.mjs'))} ${quote(endpoint)}`;
      const replacements = {
        name, num: config.summaryEvery, totalRounds: config.totalRounds,
        serverUrl: config.serverUrl.replace(/^ws/, 'http'), agentDir: directory,
        mcpEndpoint: endpoint, mcpCall: call,
        role: index === 0
          ? `你负责创建牌桌，调用 set_option 将 totalRounds 设为 ${config.totalRounds}，将房间号报告裁判。等另外两人进入并准备后开始。`
          : '等待裁判给出房间号后加入该桌并准备，不另建房间。',
      };
      let prompt = template.replace(/\{(\w+)\}/g, (original, key) => key in replacements ? String(replacements[key]) : original);
      await fs.writeFile(path.join(directory, '接入说明.md'), prompt, { flag: 'wx' });
      await fs.writeFile(path.join(directory, 'mcp-tools.json'), JSON.stringify(tools, null, 2) + '\n', { flag: 'wx' });
      await fs.writeFile(path.join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { landlord: { url: endpoint } } }, null, 2) + '\n', { flag: 'wx' });
      manifest.players.push({ name, endpoint, pid: child.pid, directory, instructions: path.join(directory, '接入说明.md') });
    }
    // 仅探测公共大厅，不创建身份、不取任何玩家手牌。
    await withClient(manifest.players[0].endpoint, async client => unwrap(await client.callTool({ name: 'list_rooms', arguments: {} })));
    manifest.status = 'ready';
    await save();
    await fs.writeFile(path.join(runtime, '比赛计分.csv'), '\uFEFF比赛局序,牌桌,牌桌局号,' + config.players.map(n => n + '本局得分').join(',') + ',' + config.players.map(n => n + '累计总分').join(',') + ',结算确认\n', { flag: 'wx' });
    return { manifest, runtime, stop, children };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let running;
  let stopRequested = false;
  const shutdown = async () => { stopRequested = true; if (running) await running.stop(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    const configFile = process.argv[2];
    if (!configFile) throw new Error('用法：node referee/start.mjs <比赛配置.json>');
    running = await launch(JSON.parse(await fs.readFile(path.resolve(configFile), 'utf8')));
    if (stopRequested) await running.stop();
    else {
      console.log(JSON.stringify({ status: 'ready', manifest: path.join(running.runtime, 'manifest.json'), players: running.manifest.players }, null, 2));
      for (const child of running.children) child.once('exit', async () => {
        if (running.manifest.status === 'ready') {
          console.error('MCP 进程意外退出；停止本组接入服务，请裁判处理恢复。');
          process.exitCode = 1;
          await running.stop();
        }
      });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
