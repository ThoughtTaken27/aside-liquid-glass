import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GENESIS, Ledger, canonicalJson, cleanText } from '../src/ledger.js';

let dir: string;
let file: string;
let keyFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-ledger-'));
  file = path.join(dir, 'state', 'ledger.jsonl');
  keyFile = path.join(dir, 'state', 'ledger.key');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = new Date('2026-09-25T17:00:00Z');
function fill(l: Ledger, n: number): void {
  for (let i = 0; i < n; i += 1) {
    l.append({ actor: i % 2 ? 'agent' : 'you', kind: 'test', summary: `entry ${i + 1}` }, new Date(T0.getTime() + i * 1000));
  }
}
function lines(): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

describe('Ledger chain', () => {
  it('chains from genesis and verifies', () => {
    const l = new Ledger(file, keyFile);
    fill(l, 5);
    const v = l.verify();
    expect(v).toMatchObject({ ok: true, count: 5, brokenAt: null });
    const first = JSON.parse(lines()[0]);
    expect(first.prev).toBe(GENESIS);
    expect(first.seq).toBe(1);
    expect(JSON.parse(lines()[1]).prev).toBe(first.hash);
    expect(l.last()?.seq).toBe(5);
  });

  it('reloads the chain on construction and keeps going', () => {
    fill(new Ledger(file, keyFile), 3);
    const l2 = new Ledger(file, keyFile);
    expect(l2.last()?.seq).toBe(3);
    l2.append({ actor: 'system', kind: 'boot', summary: 'again' });
    expect(l2.verify()).toMatchObject({ ok: true, count: 4 });
  });

  it('editing any line breaks verify at that seq', () => {
    for (let target = 0; target < 4; target += 1) {
      fs.rmSync(path.join(dir, 'state'), { recursive: true, force: true });
      const l = new Ledger(file, keyFile);
      fill(l, 4);
      const ls = lines();
      const e = JSON.parse(ls[target]);
      e.summary = 'rewritten';
      ls[target] = JSON.stringify(e);
      fs.writeFileSync(file, `${ls.join('\n')}\n`);
      expect(l.verify()).toMatchObject({ ok: false, brokenAt: target + 1 });
    }
  });

  it('re-hashing an edit without the key still breaks', () => {
    const l = new Ledger(file, keyFile);
    fill(l, 3);
    const ls = lines();
    const e = JSON.parse(ls[1]);
    e.summary = 'forged';
    e.hash = 'f'.repeat(64);
    ls[1] = JSON.stringify(e);
    fs.writeFileSync(file, `${ls.join('\n')}\n`);
    expect(l.verify()).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('deleting a middle line breaks', () => {
    const l = new Ledger(file, keyFile);
    fill(l, 5);
    const ls = lines();
    ls.splice(2, 1);
    fs.writeFileSync(file, `${ls.join('\n')}\n`);
    expect(l.verify()).toMatchObject({ ok: false, brokenAt: 3, count: 2 });
  });

  it('deleting the first line breaks', () => {
    const l = new Ledger(file, keyFile);
    fill(l, 3);
    fs.writeFileSync(file, `${lines().slice(1).join('\n')}\n`);
    expect(l.verify()).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it('tolerates a truncated trailing line and repairs it on append', () => {
    const l = new Ledger(file, keyFile);
    fill(l, 3);
    fs.appendFileSync(file, '{"seq":4,"at":"2026-');
    expect(l.verify()).toMatchObject({ ok: true, count: 3 });
    const fresh = new Ledger(file, keyFile);
    expect(fresh.last()?.seq).toBe(3);
    expect(fresh.list().entries).toHaveLength(3);
    fresh.append({ actor: 'you', kind: 'test', summary: 'after crash' });
    expect(fresh.verify()).toMatchObject({ ok: true, count: 4 });
    expect(lines()).toHaveLength(4);
  });

  it('creates the key and ledger 0600 and the directory 0700', () => {
    const l = new Ledger(file, keyFile);
    fill(l, 1);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(keyFile, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a different key fails verification', () => {
    fill(new Ledger(file, keyFile), 2);
    const other = path.join(dir, 'other.key');
    expect(new Ledger(file, other).verify()).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it('refuses a malformed key file instead of silently replacing it', () => {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, 'not-a-key');
    expect(() => new Ledger(file, keyFile)).toThrow(/malformed/);
  });

  it('rejects an unknown actor', () => {
    const l = new Ledger(file, keyFile);
    expect(() => l.append({ actor: 'root' as never, kind: 'x', summary: 'y' })).toThrow();
  });
});

describe('Ledger sanitization', () => {
  it('strips bidi, zero-width and control characters and collapses whitespace', () => {
    const l = new Ledger(file, keyFile);
    const e = l.append({
      actor: 'sorter',
      kind: 'mail\u0000.sort',
      summary: 'Pay\u202Eyrtne\u202C fee\u200B now\n\n\tplease\u2066x\u2069\uFEFF',
      detail: { host: 'school\u200D.example', n: 3, ok: true, none: null },
    });
    expect(e.summary).toBe('Payyrtne fee now pleasex');
    expect(e.kind).toBe('mail .sort');
    expect(e.detail).toEqual({ host: 'school.example', n: 3, ok: true, none: null });
    expect(l.verify().ok).toBe(true);
  });

  it('caps summary and detail values at 200 and keeps at most 12 valid detail keys', () => {
    const l = new Ledger(file, keyFile);
    const detail: Record<string, unknown> = { 'bad key': 'x', '1bad': 'x', __proto: 'x' };
    for (let i = 0; i < 20; i += 1) detail[`k${i}`] = 'v'.repeat(500);
    const e = l.append({ actor: 'agent', kind: 'k', summary: 's'.repeat(1000), detail });
    expect(e.summary.length).toBe(200);
    const keys = Object.keys(e.detail ?? {});
    expect(keys.length).toBe(12);
    expect(keys).not.toContain('bad key');
    expect(keys).not.toContain('1bad');
    for (const v of Object.values(e.detail ?? {})) {
      if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(200);
    }
  });

  it('turns non-finite numbers into null and drops bad risk values', () => {
    const l = new Ledger(file, keyFile);
    const e = l.append({ actor: 'agent', kind: 'k', summary: 's', detail: { n: Infinity }, risk: 'extreme' as never });
    expect(e.detail).toEqual({ n: null });
    expect(e.risk).toBeUndefined();
    const f = l.append({ actor: 'agent', kind: 'k', summary: 's', risk: 'high' });
    expect(f.risk).toBe('high');
  });

  it('cleanText and canonicalJson are stable', () => {
    expect(cleanText('  a\u200Bb  \u0007c ', 50)).toBe('ab c');
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
  });
});

describe('Ledger list', () => {
  it('lists newest first with a limit and more flag', () => {
    const l = new Ledger(file, keyFile);
    fill(l, 10);
    const page = l.list({ limit: 3 });
    expect(page.entries.map((e) => e.seq)).toEqual([10, 9, 8]);
    expect(page.more).toBe(true);
    const next = l.list({ limit: 3, beforeSeq: 8 });
    expect(next.entries.map((e) => e.seq)).toEqual([7, 6, 5]);
    const tail = l.list({ limit: 50, beforeSeq: 3 });
    expect(tail.entries.map((e) => e.seq)).toEqual([2, 1]);
    expect(tail.more).toBe(false);
  });

  it('defaults to 50 and caps at 200', () => {
    const l = new Ledger(file, keyFile);
    fill(l, 230);
    expect(l.list().entries).toHaveLength(50);
    expect(l.list({ limit: 1000 }).entries).toHaveLength(200);
    expect(l.list({ limit: 1000 }).more).toBe(true);
  });

  it('filters by actor and by the agents group', () => {
    const l = new Ledger(file, keyFile);
    for (const actor of ['you', 'sorter', 'drafter', 'planner', 'inspector', 'agent', 'system'] as const) {
      l.append({ actor, kind: 'k', summary: actor });
    }
    expect(l.list({ actor: 'you' }).entries.map((e) => e.actor)).toEqual(['you']);
    expect(new Set(l.list({ actor: 'agents' }).entries.map((e) => e.actor))).toEqual(
      new Set(['sorter', 'drafter', 'planner', 'inspector', 'agent']),
    );
  });

  it('returns nothing for a missing file', () => {
    const l = new Ledger(file, keyFile);
    expect(l.list()).toEqual({ entries: [], more: false });
    expect(l.verify()).toMatchObject({ ok: true, count: 0 });
    expect(l.last()).toBeNull();
  });
});

describe('Ledger rotation', () => {
  it('rotates past the size limit and links the new chain to the old one', () => {
    const l = new Ledger(file, keyFile, { maxBytes: 2000 });
    fill(l, 12);
    const rotated = fs.readdirSync(path.dirname(file)).filter((f) => /^ledger\.jsonl\..+\.jsonl$/.test(f));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
    expect(l.verify().ok).toBe(true);
    const current = lines().map((s) => JSON.parse(s));
    expect(current[0].seq).toBeGreaterThan(1);
    // The first entry of the new file points at the last hash of the old one.
    const allOld = rotated
      .sort()
      .flatMap((f) => fs.readFileSync(path.join(path.dirname(file), f), 'utf8').split('\n').filter(Boolean))
      .map((s) => JSON.parse(s));
    const prevOfFirst = allOld.find((e) => e.seq === current[0].seq - 1);
    expect(current[0].prev).toBe(prevOfFirst.hash);
    // A fresh instance continues the rotated chain.
    const l2 = new Ledger(file, keyFile, { maxBytes: 2000 });
    l2.append({ actor: 'system', kind: 'k', summary: 'after rotation' });
    expect(l2.verify().ok).toBe(true);
    expect(l2.last()?.seq).toBe(13);
  });

  it('continues seq and prev from the anchor when the new file is still empty', () => {
    const l = new Ledger(file, keyFile, { maxBytes: 300 });
    // Each entry is ~300+ bytes, so every append after the first rotates.
    fill(l, 4);
    const seqs = [...lines().map((s) => JSON.parse(s).seq)];
    expect(seqs[seqs.length - 1]).toBe(4);
    expect(l.verify().ok).toBe(true);
    const current = lines().map((s) => JSON.parse(s));
    if (current[0].seq > 1) expect(current[0].prev).not.toBe(GENESIS);
  });
});
