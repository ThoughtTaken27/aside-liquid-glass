import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source = fs.readFileSync(new URL('../../frontdoor/worker.js', import.meta.url), 'utf8')
  .replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject {}')
  .replace('export class OriginStore', 'class OriginStore')
  .replace('export default {', 'globalThis.worker = {');
function rig(status: number, throws = false) {
  const upstream = vi.fn(async () => { if (throws) throw new Error('ambiguous failure'); return new Response('upstream', { status }); });
  const sandbox: any = { Request, Response, Headers, URL, crypto, TextEncoder, AbortController, Uint8Array,
    setTimeout: (cb: () => void, ms: number) => ms < 2000 ? setTimeout(cb, 0) : setTimeout(cb, ms), clearTimeout,
    fetch: upstream, caches: { default: { match: async () => null } } };
  vm.runInNewContext(source, sandbox);
  const env = { ORIGIN: { idFromName: () => 'main', get: () => ({ read: async () => ({ url: 'https://synthetic.trycloudflare.com' }), log: async () => {} }) } };
  return { upstream, run: (request: Request) => sandbox.worker.fetch(request, env, { waitUntil: () => {} }) };
}
describe('frontdoor ambiguous delivery', () => {
  it.each([502, 530])('does not replay writes on %s', async status => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = rig(status); const response = await r.run(new Request('https://frontdoor.example/api/action', { method, body: '{}', headers: { 'content-length': '2' } }));
      expect(response.status).toBe(503); expect(r.upstream).toHaveBeenCalledTimes(1);
    }
  });
  it('does not replay a write after a transport exception', async () => { const r = rig(502, true); await r.run(new Request('https://frontdoor.example/api/action', { method: 'POST', body: '{}' })); expect(r.upstream).toHaveBeenCalledTimes(1); });
  it('retries a GET transport failure only once', async () => { const r = rig(502, true); await r.run(new Request('https://frontdoor.example/api/health')); expect(r.upstream).toHaveBeenCalledTimes(2); });
  it('still retries idempotent reads', async () => { const r = rig(530); await r.run(new Request('https://frontdoor.example/api/health')); expect(r.upstream).toHaveBeenCalledTimes(4); });
  it('does not retry websocket upgrades', async () => { const r = rig(530); await r.run(new Request('https://frontdoor.example/ws', { headers: { upgrade: 'websocket' } })); expect(r.upstream).toHaveBeenCalledTimes(1); });
});

it('development proxy retains the default DNS-rebinding Host protection', () => {
  const vite = fs.readFileSync(new URL('../../web/vite.config.ts', import.meta.url), 'utf8');
  expect(vite).not.toMatch(/allowedHosts\s*:\s*true/);
  expect(vite).toContain("host: '127.0.0.1'");
});
