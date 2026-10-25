import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Jev, type JevLane, type JevQuestions } from '../src/jev.js';

const Q: JevQuestions = { bait: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } } };

describe('Jev budget per network lane (home / X-VPN)', () => {
  it('gives each lane its own count and its own 429 pause, and persists both', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevlane-'));
    let lane: JevLane = 'home';
    let status = 200;
    const mk = () =>
      new Jev({
        endpoint: () => ({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: 'k', model: 'm' }),
        stateDir: dir,
        cap: 4,
        lane: () => lane,
        now: () => Date.parse('2026-09-28T14:00:00Z'),
        fetchImpl: (async () => (status === 200 ? new Response(JSON.stringify({ answers: { bait: { type: 'noul', noul: 0.5 } } })) : new Response('{}', { status }))) as typeof fetch,
      });
    const jev = mk();
    for (let i = 0; i < 4; i++) expect((await jev.ask({ state: `h${i}`, questions: Q, tier: 'safety', feature: 't' })).ok).toBe(true);
    expect((await jev.ask({ state: 'h5', questions: Q, tier: 'safety', feature: 't' })).ok).toBe(false);
    lane = 'vpn';
    expect((await jev.ask({ state: 'v1', questions: Q, tier: 'safety', feature: 't' })).ok).toBe(true);
    status = 429;
    expect((await jev.ask({ state: 'v2', questions: Q, tier: 'safety', feature: 't' })).ok).toBe(false);
    expect(jev.status().lanes).toEqual({ home: { used: 4, paused: false }, vpn: { used: 1, paused: true } });
    jev.flush();
    lane = 'home';
    const again = mk();
    expect(again.status().used).toBe(4);
    expect(again.status().lane).toBe('home');
  });
});
