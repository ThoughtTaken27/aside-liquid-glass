import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClefDoor, fileCreds, NEURONS_PER_M, type ClefModel } from '../src/clef.js';
import { Jev, chainFor, fileRoutes, parseRoutes, type JevQuestions, type RouteTable } from '../src/jev.js';

const Q: JevQuestions = { bait: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } } };
const CHOICE: JevQuestions = { route: { type: 'choice', instructions: 'x', criteria: { chat: 'c', live: 'l' } } };
const CREDS = { accountId: '0123456789abcdef0123456789abcdef', token: 'cfut_testtokentesttokentesttoken1234567890' };
const T0 = Date.parse('2026-10-05T12:00:00Z');

type Reply = { status?: number; body?: unknown; throws?: boolean; delay?: number; headers?: Record<string, string> };

function clefRig(opts: { replies?: Reply[]; cap?: number; creds?: boolean; tokens?: number; hedgeMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clef-'));
  let t = T0;
  const replies = [...(opts.replies ?? [])];
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const r = replies.shift() ?? {};
    if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
    if (r.throws) throw new Error('net');
    const status = r.status ?? 200;
    const body = r.body ?? { success: true, result: { answers: { bait: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: opts.tokens ?? 1000, output_tokens: 0 } } };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: r.headers });
  }) as unknown as typeof fetch;
  const mk = () =>
    new ClefDoor({
      creds: () => (opts.creds === false ? null : CREDS),
      stateDir: dir,
      neuronCap: opts.cap ?? 8000,
      hedgeMs: opts.hedgeMs ?? 900,
      fetchImpl,
      now: () => t,
    });
  return { clef: mk(), mk, dir, seen, tick: (ms: number) => (t += ms), replies };
}

const ask = (c: ClefDoor, model: ClefModel, state: string, extra: Partial<Parameters<ClefDoor['ask']>[1]> = {}) =>
  c.ask(model, { state, questions: Q, tier: 'you', feature: 't', ...extra });

describe('fileCreds', () => {
  it('reads a valid file, rejects a bad one, and re-reads after a change', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')), 'clef.json');
    const read = fileCreds(f);
    expect(read()).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ accountId: 'nope', token: 'short' }));
    expect(read()).toBeNull();
    fs.writeFileSync(f, JSON.stringify(CREDS));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(f, future, future);
    expect(read()).toEqual(CREDS);
  });
});

describe('ClefDoor', () => {
  it('sends the right request: model path, bearer token, no content-type header', async () => {
    const r = clefRig();
    await ask(r.clef, 'clef-flash', 's');
    const { url, init } = r.seen[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${CREDS.accountId}/ai/run/@cf/cloudflare/clef-flash`);
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${CREDS.token}`);
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('content-type');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'clef-flash', state: 's', questions: Q });
  });

  it('answers, caches per model, and charges Neurons from the real token count', async () => {
    const r = clefRig({ tokens: 1000 });
    const a = await ask(r.clef, 'clef-flash', 's');
    const b = await ask(r.clef, 'clef-flash', 's');
    expect(a.ok && a.answers.bait).toEqual({ type: 'noul', noul: 0.9 });
    expect(a.ok && a.via).toBe('clef-flash');
    expect(b.ok && b.cached).toBe(true);
    expect(r.seen).toHaveLength(1);
    expect(r.clef.status().neurons).toBeCloseTo((1000 * NEURONS_PER_M['clef-flash']) / 1e6, 1);
    // A different model is a different cache entry and a different price.
    await ask(r.clef, 'clef', 's');
    expect(r.seen).toHaveLength(2);
    expect(r.clef.status().byModel).toEqual({ 'clef-flash': 1, clef: 1 });
    expect(r.clef.status().neurons).toBeCloseTo((1000 * (NEURONS_PER_M['clef-flash'] + NEURONS_PER_M.clef)) / 1e6, 1);
  });

  it('merges identical in-flight requests into one call', async () => {
    const r = clefRig();
    await Promise.all([1, 2, 3].map(() => ask(r.clef, 'clef-flash', 'same')));
    expect(r.seen).toHaveLength(1);
  });

  it('is off without credentials and never calls out', async () => {
    const r = clefRig({ creds: false });
    expect(await ask(r.clef, 'clef-flash', 's')).toEqual({ ok: false, why: 'off' });
    expect(r.seen).toHaveLength(0);
    expect(r.clef.status().state).toBe('off');
    expect(r.clef.leftCalls('safety')).toBe(0);
  });

  it('respects the daily Neuron cap by tier so safety checks keep room', async () => {
    // 1000 tokens of clef = 21.8 neurons. Cap 100: background 55, you 85, safety 100.
    // The check uses a pre-call estimate, so the last call may overshoot a ceiling by one call's cost.
    const r = clefRig({ cap: 100, tokens: 1000 });
    const bg = [];
    for (let i = 0; i < 4; i++) bg.push(await ask(r.clef, 'clef', `b${i}`, { tier: 'background' }));
    expect(bg.filter((x) => x.ok)).toHaveLength(3);
    expect(bg.at(-1)).toEqual({ ok: false, why: 'budget' });
    expect((await ask(r.clef, 'clef', 'mail', { tier: 'safety' })).ok).toBe(true);
  });

  it('pauses until midnight UTC when the daily allowance is gone, then probes the next day', async () => {
    const body = { success: false, errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] };
    const r = clefRig({ replies: [{ status: 429, body }] });
    expect(await ask(r.clef, 'clef-flash', 'a', { tier: 'safety' })).toEqual({ ok: false, why: 'paused' });
    expect(r.clef.status().state).toBe('paused');
    expect(r.clef.status().pausedUntil).toBe('2026-10-06T00:00:00.000Z');
    r.tick(11 * 3600_000);
    expect(await ask(r.clef, 'clef-flash', 'b', { tier: 'safety' })).toEqual({ ok: false, why: 'paused' });
    expect(r.seen).toHaveLength(1);
    r.tick(60 * 60_000 + 1000);
    const probe = await ask(r.clef, 'clef-flash', 'c', { tier: 'safety' });
    expect(probe.ok).toBe(true);
    expect(r.clef.status().state).toBe('ok');
    expect(r.clef.status().neurons).toBeGreaterThan(0);
    expect(r.clef.status().day).toBe('2026-10-06');
  });

  it('pauses only briefly on an ordinary 429, and says what Cloudflare said', async () => {
    const r = clefRig({ replies: [{ status: 429, body: { success: false, errors: [{ code: 2001, message: 'slow down' }] } }] });
    await ask(r.clef, 'clef-flash', 'a');
    expect(r.clef.status().state).toBe('paused');
    expect(r.clef.status().lastError).toContain('slow down');
    r.tick(21_000);
    expect((await ask(r.clef, 'clef-flash', 'b')).ok).toBe(true);
  });

  it('honors Retry-After on a 429 (capped at a minute)', async () => {
    const r = clefRig({ replies: [{ status: 429, body: '{}', headers: { 'retry-after': '40' } }] });
    await ask(r.clef, 'clef-flash', 'a');
    r.tick(30_000);
    expect(r.clef.status().state).toBe('paused');
    r.tick(11_000);
    expect((await ask(r.clef, 'clef-flash', 'b')).ok).toBe(true);
    const big = clefRig({ replies: [{ status: 429, body: '{}', headers: { 'retry-after': '3600' } }] });
    await ask(big.clef, 'clef-flash', 'a');
    big.tick(61_000);
    expect((await ask(big.clef, 'clef-flash', 'b')).ok).toBe(true);
  });

  it('charges the exact Neurons Cloudflare reports in the cf-ai-neurons header', async () => {
    const r = clefRig({ tokens: 1000, replies: [{ headers: { 'cf-ai-neurons': '3.5' } }] });
    await ask(r.clef, 'clef-flash', 's');
    expect(r.clef.status().neurons).toBe(3.5);
  });

  it('pauses 10 minutes when the token is rejected and says so, without leaking the token', async () => {
    const r = clefRig({ replies: [{ status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } }] });
    expect(await ask(r.clef, 'clef-flash', 'a')).toEqual({ ok: false, why: 'error' });
    expect(r.clef.status().state).toBe('paused');
    expect(r.clef.status().lastError).toContain('token rejected');
    expect(JSON.stringify(r.clef.status())).not.toContain(CREDS.token);
    r.tick(11 * 60_000);
    expect((await ask(r.clef, 'clef-flash', 'b')).ok).toBe(true);
  });

  it('does not pause everyone for a malformed request (422), but records it', async () => {
    const r = clefRig({ replies: [{ status: 422, body: '{}' }] });
    expect(await ask(r.clef, 'clef-flash', 'a')).toEqual({ ok: false, why: 'error' });
    expect(r.clef.status().state).toBe('ok');
    expect(r.clef.status().lastError).toContain('422');
    expect((await ask(r.clef, 'clef-flash', 'b')).ok).toBe(true);
  });

  it('pauses 2 minutes after three failed requests (each already retried once)', async () => {
    const r = clefRig({ replies: Array.from({ length: 6 }, () => ({ throws: true })) });
    for (const s of ['a', 'b', 'c']) expect(await ask(r.clef, 'clef-flash', s)).toEqual({ ok: false, why: 'error' });
    expect(r.clef.status().state).toBe('paused');
    expect(await ask(r.clef, 'clef-flash', 'd')).toEqual({ ok: false, why: 'paused' });
    r.tick(3 * 60_000);
    expect((await ask(r.clef, 'clef-flash', 'e')).ok).toBe(true);
  });

  it('treats an off-shape answer, a missing answer, or success:false as a failure, never a guess', async () => {
    const bad = [
      { success: true, result: { answers: { bait: { type: 'noul', noul: 7 } }, usage: { input_tokens: 10 } } },
      { success: true, result: { answers: {}, usage: { input_tokens: 10 } } },
      { success: false, errors: [{ message: 'x' }], result: {} },
      'not json',
    ];
    for (const body of bad) {
      const r = clefRig({ replies: [{ body }] });
      expect(await ask(r.clef, 'clef-flash', 'x')).toEqual({ ok: false, why: 'error' });
      expect(r.clef.status().neurons).toBe(0);
    }
  });

  it('validates choice answers against the question', async () => {
    const good = { success: true, result: { answers: { route: { type: 'choice', choice: 'chat', confidence: 0.9, probabilities: { chat: 0.95, live: 0.05 } } }, usage: { input_tokens: 50 } } };
    const r = clefRig({ replies: [{ body: good }] });
    const a = await r.clef.ask('clef-flash', { state: 'hi', questions: CHOICE, tier: 'you', feature: 't' });
    expect(a.ok && a.answers.route).toMatchObject({ choice: 'chat' });
    const wrong = { success: true, result: { answers: { route: { type: 'choice', choice: 'zzz', confidence: 0.9, probabilities: { chat: 0.5, live: 0.5 } } }, usage: { input_tokens: 50 } } };
    const r2 = clefRig({ replies: [{ body: wrong }] });
    expect(await r2.clef.ask('clef-flash', { state: 'hi', questions: CHOICE, tier: 'you', feature: 't' })).toEqual({ ok: false, why: 'error' });
  });

  it('counts failures by reason', async () => {
    const r = clefRig({ replies: [{ status: 422, body: '{}' }, { status: 500, body: '{}' }, { status: 500, body: '{}' }, { throws: true }, { throws: true }] });
    await ask(r.clef, 'clef-flash', 'a');
    await ask(r.clef, 'clef-flash', 'b');
    await ask(r.clef, 'clef-flash', 'c');
    expect(r.clef.status().errors).toEqual({ 'request rejected (422)': 1, 'http 500': 1, 'network or timeout': 1 });
  });

  it('hedges: a stalled first request is raced by a second, and the faster answer wins', async () => {
    const r = clefRig({ hedgeMs: 20, replies: [{ delay: 300 }, {}] });
    const t = Date.now();
    const a = await ask(r.clef, 'clef-flash', 'slow');
    expect(a.ok).toBe(true);
    expect(Date.now() - t).toBeLessThan(200);
    expect(r.seen).toHaveLength(2);
  });

  it('counts hedges and slow calls for status', async () => {
    const r = clefRig({ hedgeMs: 20, replies: [{ delay: 100 }, {}] });
    await ask(r.clef, 'clef-flash', 'slow');
    expect(r.clef.status().hedges).toBe(1);
    expect(r.clef.status().slow).toBe(0);
  });

  it('does not send a second request when the first answers quickly', async () => {
    const r = clefRig({ hedgeMs: 200 });
    await ask(r.clef, 'clef-flash', 'fast');
    await new Promise((res) => setTimeout(res, 260));
    expect(r.seen).toHaveLength(1);
  });

  it('retries at once after a network error or a 5xx, without counting it as a failure', async () => {
    const a = clefRig({ replies: [{ throws: true }, {}] });
    expect((await ask(a.clef, 'clef-flash', 'x')).ok).toBe(true);
    expect(a.seen).toHaveLength(2);
    expect(a.clef.status().errors).toEqual({});
    const b = clefRig({ replies: [{ status: 503, body: '{}' }, {}] });
    expect((await ask(b.clef, 'clef-flash', 'y')).ok).toBe(true);
    expect(b.seen).toHaveLength(2);
  });

  it('survives a restart: ledger and cache come back from disk', async () => {
    const r = clefRig({ tokens: 500 });
    await ask(r.clef, 'clef-flash', 'keep');
    r.clef.flush();
    const again = r.mk();
    expect(again.status().calls).toBe(1);
    const b = await ask(again, 'clef-flash', 'keep');
    expect(b.ok && b.cached).toBe(true);
    expect(r.seen).toHaveLength(1);
  });
});

describe('route table', () => {
  it('parses, drops junk, and matches exact, then prefix, then star', () => {
    const t = parseRoutes({ enabled: true, routes: { 'heyaside.route': ['clef-flash', 'jev', 'jev', 'bogus'], 'mail.*': ['jev', 'clef'], '*': ['jev'], bad: 'x', empty: [] } })!;
    expect(t.routes['heyaside.route']).toEqual(['clef-flash', 'jev']);
    expect(chainFor(t, 'heyaside.route')).toEqual(['clef-flash', 'jev']);
    expect(chainFor(t, 'mail.school')).toEqual(['jev', 'clef']);
    expect(chainFor(t, 'next.dupes')).toEqual(['jev']);
    expect(chainFor(null, 'anything')).toEqual(['jev']);
  });

  it('is off unless enabled is exactly true', () => {
    expect(parseRoutes({ enabled: false, routes: { '*': ['clef'] } })).toBeNull();
    expect(parseRoutes({ routes: { '*': ['clef'] } })).toBeNull();
    expect(parseRoutes('x')).toBeNull();
    expect(parseRoutes({ enabled: true, routes: {} })).toBeNull();
  });

  it('prefers the longest matching prefix', () => {
    const t = parseRoutes({ enabled: true, routes: { 'a.*': ['clef'], 'a.b.*': ['clef-flash'] } })!;
    expect(chainFor(t, 'a.b.c')).toEqual(['clef-flash']);
    expect(chainFor(t, 'a.z')).toEqual(['clef']);
  });

  it('reads the file, and a missing or broken file means Jev only', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')), 'jev-routes.json');
    const read = fileRoutes(f);
    expect(read()).toBeNull();
    fs.writeFileSync(f, '{broken');
    expect(read()).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ enabled: true, routes: { '*': ['clef'] } }));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(f, future, future);
    expect(read()?.routes['*']).toEqual(['clef']);
  });
});

describe('Jev with a Clef door', () => {
  function rig(o: { routes?: RouteTable | null; clefReplies?: Reply[]; jevStatus?: number[]; jevCap?: number; clefCreds?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevclef-'));
    const t = T0;
    const clefR = clefRig({ replies: o.clefReplies, creds: o.clefCreds });
    let jevCalls = 0;
    const jevStatuses = [...(o.jevStatus ?? [])];
    const jevFetch = (async () => {
      jevCalls++;
      const st = jevStatuses.shift() ?? 200;
      if (st !== 200) return new Response('{}', { status: st });
      return new Response(JSON.stringify({ answers: { bait: { type: 'noul', noul: 0.1 } } }), { status: 200 });
    }) as typeof fetch;
    const jev = new Jev({
      endpoint: () => ({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: 'k', model: 'oc/jev-1.13-free' }),
      stateDir: dir,
      cap: o.jevCap ?? 10,
      fetchImpl: jevFetch,
      now: () => t,
      clef: clefR.clef,
      routes: o.routes === undefined ? undefined : () => o.routes!,
    });
    return { jev, clefR, jevCalls: () => jevCalls };
  }
  const table = (routes: Record<string, string[]>) => parseRoutes({ enabled: true, routes })!;
  const ask = (j: Jev, feature: string, state = 's', extra: object = {}) => j.ask({ state, questions: Q, tier: 'you', feature, ...extra });

  it('without routes behaves exactly like before: Jev only, Clef never called', async () => {
    const r = rig();
    const a = await ask(r.jev, 'heyaside.route');
    expect(a.ok && a.answers.bait).toEqual({ type: 'noul', noul: 0.1 });
    expect(r.jevCalls()).toBe(1);
    expect(r.clefR.seen).toHaveLength(0);
    expect(r.jev.status().clef).toBeDefined();
    expect(r.jev.status().routes).toBeNull();
  });

  it('routes a feature to Clef-flash first and does not touch Jev when Clef answers', async () => {
    const r = rig({ routes: table({ 'heyaside.route': ['clef-flash', 'jev'], '*': ['jev'] }) });
    const a = await ask(r.jev, 'heyaside.route');
    expect(a.ok && a.via).toBe('clef-flash');
    expect(a.ok && a.answers.bait).toEqual({ type: 'noul', noul: 0.9 });
    expect(r.jevCalls()).toBe(0);
    // Other features still go to Jev.
    const b = await ask(r.jev, 'next.dupes', 'x');
    expect(b.ok && b.via).toBeUndefined();
    expect(r.jevCalls()).toBe(1);
  });

  it('falls back to Jev when Clef fails, and back to Clef when Jev is out', async () => {
    const down = rig({ routes: table({ '*': ['clef-flash', 'jev'] }), clefReplies: [{ status: 500, body: '{}' }, { status: 500, body: '{}' }] });
    const a = await ask(down.jev, 'x');
    expect(a.ok && a.answers.bait).toEqual({ type: 'noul', noul: 0.1 });
    expect(down.jevCalls()).toBe(1);

    const out = rig({ routes: table({ '*': ['jev', 'clef'] }), jevStatus: [429] });
    const b = await ask(out.jev, 'mail.school');
    expect(b.ok && b.via).toBe('clef');
    expect(out.jevCalls()).toBe(1);
    // Jev is paused now; the next one goes straight to Clef.
    const c = await ask(out.jev, 'mail.school', 'other');
    expect(c.ok && c.via).toBe('clef');
    expect(out.jevCalls()).toBe(1);
  });

  it('returns the last refusal when every backend refuses', async () => {
    const r = rig({ routes: table({ '*': ['clef-flash', 'jev'] }), clefCreds: false, jevStatus: [500] });
    expect(await ask(r.jev, 'x')).toEqual({ ok: false, why: 'error' });
  });

  it('never sends private-looking text to any backend', async () => {
    const r = rig({ routes: table({ '*': ['clef-flash', 'jev'] }) });
    const s = 'Your verification code is 482913';
    expect(await ask(r.jev, 'x', s)).toEqual({ ok: false, why: 'private' });
    expect(r.jevCalls()).toBe(0);
    expect(r.clefR.seen).toHaveLength(0);
    expect((await ask(r.jev, 'x', s, { allowPrivate: true })).ok).toBe(true);
  });

  it('refuses oversized text before any backend sees it', async () => {
    const r = rig({ routes: table({ '*': ['clef-flash', 'jev'] }) });
    expect(await ask(r.jev, 'x', 'a'.repeat(30_000))).toEqual({ ok: false, why: 'too-big' });
    expect(r.clefR.seen).toHaveLength(0);
    expect(r.jevCalls()).toBe(0);
  });

  it('counts Clef capacity in left() and canSpend() only when routes can use it', async () => {
    const off = rig({ jevCap: 2 });
    expect(off.jev.left('safety')).toBe(2);
    const on = rig({ jevCap: 2, routes: table({ '*': ['jev', 'clef'] }) });
    expect(on.jev.left('safety')).toBeGreaterThan(100);
    await ask(on.jev, 'x', 'a');
    await ask(on.jev, 'x', 'b');
    expect(on.jev.canSpend('safety', 1)).toBe(true);
  });

  it('shows the Clef door and the live routes in status', async () => {
    const r = rig({ routes: table({ 'heyaside.*': ['clef-flash', 'jev'] }) });
    await ask(r.jev, 'heyaside.route');
    const s = r.jev.status();
    expect(s.clef?.calls).toBe(1);
    expect(s.routes).toEqual({ 'heyaside.*': ['clef-flash', 'jev'] });
    expect(s.used).toBe(0);
  });
});
