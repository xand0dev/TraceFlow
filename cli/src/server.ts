import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { Core } from './core.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(here, 'web');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export interface ServeOptions {
  port: number;
  host: string;
  telemetryPort: number;
  log: (msg: string) => void;
}

/** Map UI, state API, live events (SSE), and the two telemetry inputs (HTTP POST and WebSocket). */
export function serve(core: Core, opts: ServeOptions): Promise<{ url: string; close: () => void }> {
  const clients = new Set<ServerResponse>();
  const send = (event: string, data: unknown) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(chunk);
  };
  core.on('state', (s) => send('state', s));
  core.on('traffic', (t) => send('traffic', t));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (req.method === 'OPTIONS') return cors(res).end();
      if (url.pathname === '/api/health') return json(res, { ok: true, app: 'traceflow', root: core.root });
      if (url.pathname === '/api/state') return json(res, core.state());
      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: state\ndata: ${JSON.stringify(core.state())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (url.pathname === '/api/ingest' && req.method === 'POST') {
        const body = await readBody(req);
        const items = Array.isArray(body) ? body : [body];
        const accepted = items.map((i) => core.ingest(i)).filter(Boolean).length;
        return json(cors(res), { accepted });
      }
      if (url.pathname === '/api/baseline' && req.method === 'POST') {
        core.resetBaseline();
        return json(res, { ok: true });
      }
      if (url.pathname === '/api/rescan' && req.method === 'POST') {
        await core.rescan();
        return json(res, { ok: true });
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (file.includes('..')) return notFound(res);
      const ext = file.slice(file.lastIndexOf('.'));
      const content = await readFile(join(WEB_DIR, file)).catch(() => null);
      if (!content) return notFound(res);
      res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' });
      res.end(content);
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });

  // Telemetry over WebSocket on the port the SDKs already use.
  const wss = new WebSocketServer({ port: opts.telemetryPort, host: opts.host });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        core.ingest(JSON.parse(raw.toString()));
      } catch {}
    });
  });
  wss.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      opts.log(`telemetry port ${opts.telemetryPort} is busy; SDKs can still POST to /api/ingest`);
    } else {
      opts.log(`telemetry error: ${e.message}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      resolve({
        url: `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}`,
        close: () => {
          for (const res of clients) res.end();
          wss.close();
          server.close();
        },
      });
    });
  });
}

function cors(res: ServerResponse): ServerResponse {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res;
}

function json(res: ServerResponse, data: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
