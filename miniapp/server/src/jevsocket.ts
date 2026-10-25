/**
 * Local-only door to Jev for tools on this Mac (the `jev` command, Hey
 * Aside, the OpenCode guard). A Unix socket with 0600 permissions: only
 * Owner's own user can connect, nothing on the network can, and no tunnel
 * or relay ever reaches it. It never accepts the safety tier and never
 * accepts private-looking text.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Jev, JevQuestions } from './jev.js';
import type { Completer } from './inbox.js';
import { quick, reply, risk, route, same, scan, verify } from './jevtools.js';

export interface JevSocketOptions {
  jev: Jev;
  socketPath: string;
  /** The free text model for Hey Aside's fast path, or null to never answer directly. */
  complete: () => Completer | null;
  log?: (msg: string, extra?: unknown) => void;
}

const MAX_BODY = 64 * 1024;

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too_big'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => {
      try {
        const v = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

const str = (v: unknown, max = 20_000) => (typeof v === 'string' ? v.slice(0, max) : '');

export function startJevSocket(o: JevSocketOptions): { close: () => Promise<void> } {
  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://jev');
      if (req.method === 'GET' && url.pathname === '/status') return send(200, o.jev.status());
      if (req.method !== 'POST') return send(405, { ok: false, why: 'method' });
      const b = await readBody(req);
      switch (url.pathname) {
        case '/route':
          return send(200, await route(o.jev, str(b.text, 400)));
        case '/quick': {
          const hist = Array.isArray(b.history) ? (b.history as Array<{ q?: unknown; a?: unknown }>).slice(-3).map((h) => ({ q: str(h?.q, 400), a: str(h?.a, 600) })) : [];
          return send(200, await quick(o.jev, o.complete(), str(b.text, 400), hist));
        }
        case '/reply': {
          const hist = Array.isArray(b.history) ? (b.history as Array<{ q?: unknown; a?: unknown }>).slice(-3).map((h) => ({ q: str(h?.q, 300), a: str(h?.a, 300) })) : [];
          const steps = Array.isArray(b.steps) ? (b.steps as unknown[]).slice(-5).map((x) => str(x, 80)) : [];
          const kind = b.kind === 'ack' || b.kind === 'progress' ? b.kind : 'auto';
          return send(200, await reply(o.jev, o.complete(), str(b.text, 400), { history: hist, busy: b.busy === true, steps, kind }));
        }
        case '/risk':
          return send(200, await risk(o.jev, str(b.command, 4000), str(b.cwd, 300)));
        case '/verify':
          return send(200, await verify(o.jev, str(b.goal, 2000), str(b.evidence)));
        case '/same':
          return send(200, await same(o.jev, str(b.a, 4000), str(b.b, 4000)));
        case '/scan':
          return send(200, await scan(o.jev, str(b.text, 7200)));
        case '/ask': {
          // Raw typed questions for scripts. Never safety tier, never private text.
          const tier = b.tier === 'background' ? 'background' : 'you';
          const qs = (b.questions && typeof b.questions === 'object' ? b.questions : {}) as JevQuestions;
          if (Object.keys(qs).length === 0 || Object.keys(qs).length > 32) return send(400, { ok: false, why: 'questions' });
          const feature = `ext.${str(b.feature, 40).replace(/[^\w.-]/g, '') || 'ask'}`;
          return send(200, await o.jev.ask({ state: str(b.state), questions: qs, tier, feature, allowPrivate: false }));
        }
        default:
          return send(404, { ok: false, why: 'not_found' });
      }
    } catch (err) {
      return send(400, { ok: false, why: err instanceof Error ? err.message : 'error' });
    }
  });
  fs.mkdirSync(path.dirname(o.socketPath), { recursive: true, mode: 0o700 });
  try {
    fs.unlinkSync(o.socketPath);
  } catch {
    /* none left over */
  }
  const old = process.umask(0o177);
  server.listen(o.socketPath, () => {
    process.umask(old);
    try {
      fs.chmodSync(o.socketPath, 0o600);
    } catch (err) {
      o.log?.('jev socket chmod failed', err);
    }
  });
  server.on('error', (err) => o.log?.('jev socket error', err));
  return {
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        try {
          fs.unlinkSync(o.socketPath);
        } catch {
          /* gone */
        }
      }),
  };
}
