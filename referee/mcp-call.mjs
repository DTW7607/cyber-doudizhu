#!/usr/bin/env node
// 通用 MCP 客户端：一次调用一个工具；不持有游戏身份，不决定动作。
import { invoke } from './mcp-client.mjs';

try {
  const [endpoint, tool, json = '{}'] = process.argv.slice(2);
  if (!endpoint || !tool) throw new Error('用法：node referee/mcp-call.mjs <endpoint> <tool|list_tools> [JSON参数]');
  const args = JSON.parse(json);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是 JSON 对象');
  const result = await invoke(endpoint, tool, args);
  console.log(JSON.stringify(result, null, 2));
  if (result.isError) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
