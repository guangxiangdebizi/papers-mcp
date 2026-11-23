import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';

export async function stdioClient(env = {}) {
  const client = new Client({ name: 'papers-acceptance', version: '2.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['build/index.js'],
    cwd: process.cwd(), env: { ...process.env, MCP_TRANSPORT: 'stdio', ...env }, stderr: 'pipe' });
  await client.connect(transport);
  transport.stderr?.on('data', chunk => process.stderr.write(chunk));
  return client;
}
export async function httpClient(env = {}) {
  const child = spawn(process.execPath, ['build/index.js'], { env: { ...process.env, MCP_TRANSPORT: 'http', PORT: '0', HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let log = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`HTTP startup timed out: ${log}`)); }, 15000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`HTTP exited (${code}): ${log}`)); });
    child.stderr.on('data', data => {
      log += data;
      const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const client = new Client({ name: 'papers-http-acceptance', version: '2.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return { client, url, close: async () => { await client.close(); const exited = once(child, 'exit'); child.kill(); await exited; } };
}
export async function call(client, name, args, allowError = false) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  const envelope = result.structuredContent ?? result.result?.structuredContent ?? result.result;
  assert.ok(envelope?.status, `${name}: missing structuredContent: ${JSON.stringify(result)}`);
  if (!allowError) assert.notEqual(envelope.status, 'error', `${name}: ${JSON.stringify(envelope.error)}`);
  return envelope;
}
