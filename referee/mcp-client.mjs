import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/mcp/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

export async function withClient(endpoint, action) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp') {
    throw new Error('只能连接本机 http://127.0.0.1:<port>/mcp');
  }
  const client = new Client({ name: 'landlord-referee-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    return await action(client);
  } finally {
    await client.close();
  }
}

export async function invoke(endpoint, name, args = {}) {
  return withClient(endpoint, client => name === 'list_tools'
    ? client.listTools()
    : client.callTool({ name, arguments: args }, undefined, { timeout: 135000 }));
}

export function unwrap(result) {
  if (result.isError) throw new Error(result.content?.map(item => item.text || '').join('\n') || 'MCP 工具失败');
  const text = result.content?.find(item => item.type === 'text')?.text;
  return text === undefined ? result : JSON.parse(text);
}
