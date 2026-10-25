import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Jev } from '../src/jev.js';
import { NextNotify, eligible, quiet } from '../src/nextnotify.js';
import type { NextItem } from '../src/next.js';

function item(id: string, dueISO: string | null, p: Partial<NextItem> = {}): NextItem {
  return { id, title: `Task ${id}`, context: 'AP Physics', dueISO, status: 'open', trial: false, flag: null, ...p } as NextItem;
}

describe('quiet hours', () => {
  it('holds during school hours on school days and at night, not on weekends afternoons', () => {
    expect(quiet(new Date(2026, 8, 28, 10, 0))).toBe(true); // Monday 10 AM
    expect(quiet(new Date(2026, 8, 28, 16, 0))).toBe(false); // Monday 4 PM
    expect(quiet(new Date(2026, 8, 26, 10, 0))).toBe(false); // Saturday 10 AM
    expect(quiet(new Date(2026, 8, 26, 23, 30))).toBe(true);
    expect(quiet(new Date(2026, 6, 13, 10, 0))).toBe(false); // July weekday
  });
});

describe('the ping gate', () => {
  const now = new Date(2026, 8, 28, 16, 0);
  const soon = new Date(2026, 8, 28, 23, 59).toISOString();
  const later = new Date(2026, 9, 5, 23, 59).toISOString();

  it('only considers open, trusted items due within a day and a half', () => {
    expect(eligible(item('a', soon), now)).toBe(true);
    expect(eligible(item('b', later), now)).toBe(false);
    expect(eligible(item('c', soon, { flag: 'suspicious' }), now)).toBe(false);
    expect(eligible(item('d', soon, { trial: true }), now)).toBe(false);
    expect(eligible(item('e', null), now)).toBe(false);
  });

  function rig(scoreFor: (k: string) => number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-'));
    let calls = 0;
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      calls++;
      const b = JSON.parse(init.body) as { questions: Record<string, unknown> };
      return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(b.questions).map((k) => [k, { type: 'score', score: scoreFor(k), confidence: 0.9, probabilities: { 0: 0, 1: 0, 2: 0.5, 3: 0.5 } }])) }));
    }) as unknown as typeof fetch;
    const jev = new Jev({ endpoint: () => ({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: 'k', model: 'm' }), stateDir: dir, cap: 100, fetchImpl });
    let list: NextItem[] = [];
    const sent: string[] = [];
    let clock = now;
    const n = new NextNotify({ jev, statePath: path.join(dir, 's.json'), items: () => list, send: async (h) => void sent.push(h), now: () => clock });
    return { n, sent, set: (l: NextItem[]) => (list = l), at: (d: Date) => (clock = d), calls: () => calls };
  }

  it('takes stock on the first run, then pings only for new pressing items', async () => {
    const r = rig((k) => (k === 'i1' || k === 's1' ? 2.8 : 1.0));
    r.set([item('old', soon)]);
    await r.n.run();
    expect(r.sent).toHaveLength(0);
    r.set([item('old', soon), item('new1', soon), item('new2', soon)]);
    await r.n.run();
    expect(r.sent).toEqual([`<b>Next:</b> Task new1, due 11:59 PM today.`]);
    await r.n.run();
    expect(r.sent).toHaveLength(1);
  });

  it('holds during school, then sends once after, and forgets items he already finished', async () => {
    const r = rig(() => 2.9);
    r.at(new Date(2026, 8, 28, 9, 0));
    r.set([]);
    await r.n.run();
    r.set([item('x', soon), item('y', soon)]);
    await r.n.run();
    expect(r.sent).toHaveLength(0);
    r.set([item('x', soon), item('y', soon, { status: 'done' })]);
    r.at(new Date(2026, 8, 28, 15, 30));
    await r.n.run();
    expect(r.sent).toEqual([`<b>Next:</b> Task x, due 11:59 PM today.`]);
  });
});
