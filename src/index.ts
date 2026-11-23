import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { NodeStreamableHTTPServerTransport, hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import { createServer as httpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from './server.js';
import { outputDirectory } from './core/artifacts.js';

async function main() {
  const transport = process.env.MCP_TRANSPORT ?? 'stdio';
  if (transport === 'stdio') { await createServer().connect(new StdioServerTransport()); return; }
  if (transport !== 'http') throw new Error('MCP_TRANSPORT must be stdio or http.');
  const port = Number(process.env.PORT ?? '3100'), host = process.env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT.');
  const publicHost = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL).hostname : null;
  const allowed = ['localhost', '127.0.0.1', '[::1]', ...(publicHost ? [publicHost] : []), ...(host !== '0.0.0.0' && host !== '::' ? [host] : [])];
  const checkHost = hostHeaderValidation(allowed), checkOrigin = originValidation(allowed);
  const app = httpServer(async (req, res) => {
    try {
      if (!checkHost(req, res) || !checkOrigin(req, res)) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}'); return; }
      const file = /^\/files\/([a-f0-9-]{36})\/(citations\.(bib|ris|json|txt))$/.exec(url.pathname);
      if (file && req.method === 'GET') {
        try {
          const bytes = await readFile(path.join(outputDirectory(), file[1], file[2]));
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${file[2]}"`, 'content-length': bytes.length,
            'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }).end(bytes);
        } catch { res.writeHead(404).end('Not found'); }
        return;
      }
      if (url.pathname !== '/mcp') { res.writeHead(404).end('Not found'); return; }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end('Stateless MCP accepts POST only.'); return; }
      const server = createServer(), connection = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { void connection.close(); void server.close(); });
      await server.connect(connection);
      await connection.handleRequest(req, res);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      if (!res.headersSent) res.writeHead(500).end('Request failed'); else res.end();
    }
  });
  app.requestTimeout = 65_000;
  app.listen(port, host, () => console.error(`papers-mcp HTTP listening on http://${host}:${(app.address() as { port: number }).port}/mcp`));
  for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => { app.close(); app.closeAllConnections(); });
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
