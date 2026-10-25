import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Jev, readAnswer, tokens, overlap, type JevQuestions } from '../src/jev.js';

const Q: JevQuestions = { bait: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } } };

function rig(opts: { cap?: number; status?: number[]; answers?: unknown } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-'));
  let t = Date.parse('2026-09-27T12:00:00Z');
  const statuses = [...(opts.status ?? [])];
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    const st = statuses.shift() ?? 200;
    if (st !== 200) return new Response('{}', { status: st });
    return new Response(JSON.stringify({ answers: opts.answers ?? { bait: { type: 'noul', noul: 0.9 } } }), { status: 200 });
  }) as typeof fetch;
  const jev = new Jev({
    endpoint: () => ({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: 'k', model: 'oc/jev-1.13-free' }),
    stateDir: dir,
    cap: opts.cap ?? 10,
    fetchImpl,
    now: () => t,
  });
  return { jev, dir, calls: () => calls, tick: (ms: number) => (t += ms) };
}

describe('Jev shared door', () => {
  it('answers, then serves the same question from cache for free', async () => {
    const r = rig();
    const a = await r.jev.ask({ state: 's', questions: Q, tier: 'you', feature: 't' });
    const b = await r.jev.ask({ state: 's', questions: Q, tier: 'you', feature: 't' });
    expect(a.ok && a.answers.bait).toEqual({ type: 'noul', noul: 0.9 });
    expect(b.ok && b.cached).toBe(true);
    expect(r.calls()).toBe(1);
    expect(r.jev.status().used).toBe(1);
  });

  it('merges identical requests in flight into one', async () => {
    const r = rig();
    await Promise.all([1, 2, 3].map(() => r.jev.ask({ state: 'same', questions: Q, tier: 'you', feature: 't' })));
    expect(r.calls()).toBe(1);
  });

  it('keeps background work under its share so safety still has room', async () => {
    const r = rig({ cap: 10 });
    const got = [];
    for (let i = 0; i < 8; i++) got.push(await r.jev.ask({ state: `b${i}`, questions: Q, tier: 'background', feature: 'bg' }));
    expect(got.filter((g) => g.ok)).toHaveLength(5);
    expect(got.at(-1)).toEqual({ ok: false, why: 'budget' });
    const s = await r.jev.ask({ state: 'mail', questions: Q, tier: 'safety', feature: 'mail' });
    expect(s.ok).toBe(true);
  });

  it('pauses everyone for 30 minutes on a 429, then lets one probe through', async () => {
    const r = rig({ status: [429] });
    expect(await r.jev.ask({ state: 'a', questions: Q, tier: 'safety', feature: 't' })).toEqual({ ok: false, why: 'paused' });
    expect(await r.jev.ask({ state: 'b', questions: Q, tier: 'safety', feature: 't' })).toEqual({ ok: false, why: 'paused' });
    expect(r.calls()).toBe(1);
    expect(r.jev.status().state).toBe('paused');
    expect(r.jev.status().used).toBe(0);
    r.tick(31 * 60_000);
    const probe = await r.jev.ask({ state: 'c', questions: Q, tier: 'safety', feature: 't' });
    expect(probe.ok).toBe(true);
    expect(r.jev.status().state).toBe('ok');
  });

  it('refuses private-looking text unless the caller already filtered it', async () => {
    const r = rig();
    const s = 'Your verification code is 482913';
    expect(await r.jev.ask({ state: s, questions: Q, tier: 'you', feature: 't' })).toEqual({ ok: false, why: 'private' });
    expect((await r.jev.ask({ state: s, questions: Q, tier: 'safety', feature: 't', allowPrivate: true })).ok).toBe(true);
    expect(r.calls()).toBe(1);
  });

  it('treats an off-shape answer as a failure, never a guess', async () => {
    const r = rig({ answers: { bait: { type: 'noul', noul: 7 } } });
    expect(await r.jev.ask({ state: 'x', questions: Q, tier: 'you', feature: 't' })).toEqual({ ok: false, why: 'error' });
  });

  it('survives a restart: ledger and cache come back from disk', async () => {
    const r = rig();
    await r.jev.ask({ state: 'keep', questions: Q, tier: 'you', feature: 't' });
    r.jev.flush();
    const again = new Jev({ endpoint: () => ({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: 'k', model: 'oc/jev-1.13-free' }), stateDir: r.dir, cap: 10, now: () => Date.parse('2026-09-27T13:00:00Z'), fetchImpl: (async () => { throw new Error('no network'); }) as typeof fetch });
    const b = await again.ask({ state: 'keep', questions: Q, tier: 'you', feature: 't' });
    expect(b.ok && b.cached).toBe(true);
    expect(again.status().used).toBe(1);
  });

  it('validates choice and score answers against the question', () => {
    const c = { type: 'choice' as const, instructions: 'x', criteria: { a: 'A', b: 'B' } };
    expect(readAnswer(c, { choice: 'a', confidence: 0.8, probabilities: { a: 0.9, b: 0.1 } })?.type).toBe('choice');
    expect(readAnswer(c, { choice: 'z', confidence: 0.8, probabilities: { a: 0.9, b: 0.1 } })).toBeNull();
    const s = { type: 'score' as const, instructions: 'x', criteria: ['lo', 'mid', 'hi'] };
    expect(readAnswer(s, { score: 1.4, confidence: 0.3, probabilities: { 0: 0, 1: 0.6, 2: 0.4 } })?.type).toBe('score');
    expect(readAnswer(s, { score: 3, confidence: 0.3, probabilities: { 0: 0 } })).toBeNull();
  });

  it('matches words for cheap candidate finding', () => {
    expect(overlap(tokens('Gatsby essay draft due Friday'), tokens('Reminder: Great Gatsby essay'))).toBeGreaterThanOrEqual(0.5);
    expect(overlap(tokens('Physics lab'), tokens('Spanish vocab quiz'))).toBe(0);
  });
});
