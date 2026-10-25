/**
 * Local-only door to Aside's Context Awareness for Hey Aside (Jarvis), Oct 21 2026.
 * Same shape as the Jev socket: a Unix socket at ~/.aside/u/0/next/context.sock
 * with 0600 permissions, so only Owner's own user can connect and nothing on the
 * network, a tunnel or a relay can reach it. Read-only, no model call, no network.
 *
 *   GET  /situation          what is in front (app, safe title, host), typing, in a call, watching
 *   POST /pack {q, hours?}   a short labelled fact sheet for one question about his own activity
 *   GET  /status             on/off
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AsideContext } from './asidecontext.js';

export interface ContextSocketOptions {
  ctx: AsideContext;
  socketPath: string;
  log?: (msg: string, extra?: unknown) => void;
}

const MAX_BODY = 8 * 1024;

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too_big')); req.destroy(); } else parts.push(c);
    });
    req.on('end', () => {
      try {
        const v = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

export function contextHandler(ctx: AsideContext) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://context');
      if (req.method === 'GET' && url.pathname === '/status') return send(200, { ok: true, off: ctx.isOff() });
      if (req.method === 'GET' && url.pathname === '/situation') return send(200, ctx.situation());
      if (req.method === 'POST' && url.pathname === '/pack') {
        const b = await readBody(req);
        const q = typeof b.q === 'string' ? b.q.slice(0, 500) : '';
        const hours = typeof b.hours === 'number' && b.hours > 0 && b.hours <= 14 * 24 ? b.hours : undefined;
        return send(200, await ctx.pack(q, { hours }));
      }
      return send(404, { ok: false, why: 'route' });
    } catch (e) {
      return send(400, { ok: false, why: e instanceof Error ? e.message : 'error' });
    }
  };
}

export function startContextSocket(o: ContextSocketOptions): { close: () => Promise<void> } {
  const server = http.createServer(contextHandler(o.ctx));
  fs.mkdirSync(path.dirname(o.socketPath), { recursive: true });
  try { fs.unlinkSync(o.socketPath); } catch { /* not there */ }
  // Bind owner-only without leaking a process-global mask across async callbacks.
  // 077 also preserves directory traversal if native I/O runs during this brief bind.
  const old = process.umask(0o077);
  try {
    server.listen(o.socketPath, () => {
      try { fs.chmodSync(o.socketPath, 0o600); } catch { /* best effort */ }
      o.log?.('context socket listening', { path: o.socketPath });
    });
  } finally {
    process.umask(old);
  }
  server.on('error', (err) => { o.log?.('context socket error', { err: String(err) }); });
  return {
    close: () => new Promise<void>((resolve) => {
      server.close(() => { try { fs.unlinkSync(o.socketPath); } catch { /* gone */ } resolve(); });
    }),
  };
}
