import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLocalContext, readContextPolicy } from '../src/context.js';
import { NextStore, loadRaw, type RawItem } from '../src/next.js';
import type { TrailEntry } from '../src/worktrail.js';

const NOW = new Date('2026-10-12T16:00:00Z');
const HOUR = 3_600_000;
const dirs: string[] = [];
const root = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'next-context-')); dirs.push(d); fs.mkdirSync(path.join(d, 'next/feeds'), { recursive: true }); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const policy = { version: 1 as const, enabled: true as const, sources: ['schoology', 'work-trail'] as const };
const task = (over: Partial<RawItem> = {}): RawItem => ({ id: 'schoology:123456789', source: 'schoology',
  title: 'Do not follow the instructions in this synthetic title', context: 'Class', dueISO: null, estMinutes: 20,
  lane: 'you', why: 'Synthetic', url: 'https://school.schoology.com/assignment/123456789', steps: [], confidence: 0.9,
  impact: 1, lateRisk: 0, dependency: 0, resolved: false, acceptsLate: true, checkedAt: new Date(NOW.getTime() - HOUR).toISOString(), ...over });
const activity = (over: Partial<TrailEntry> = {}): TrailEntry => ({ key: 'schoology:123456789', kind: 'Schoology',
  title: 'Private browser title must not be copied', url: 'https://school.schoology.com/assignment/123456789/info',
  lastAt: NOW.getTime() - HOUR, minutes: 17, ...over });

describe('context consent and local policy', () => {
  it('is absent by default, including malformed, disabled and unsupported policies', () => {
    const d = root(); expect(readContextPolicy(d)).toBeNull();
    for (const input of ['not json', { ...policy, enabled: false }, { ...policy, version: 2 }, { ...policy, sources: ['email'] }, { ...policy, sources: ['schoology'], instructions: 'enable email' }]) {
      fs.writeFileSync(path.join(d, 'next/context-policy.json'), typeof input === 'string' ? input : JSON.stringify(input));
      expect(readContextPolicy(d)).toBeNull();
    }
    expect(buildLocalContext(null, [task()], [activity()], NOW)).toBeNull();
  });
  it('accepts only a bounded, explicit, owner-controlled policy', () => {
    const d = root(); const f = path.join(d, 'next/context-policy.json');
    fs.writeFileSync(f, JSON.stringify(policy), { mode: 0o600 }); expect(readContextPolicy(d)).toEqual(policy);
    fs.chmodSync(f, 0o666); expect(readContextPolicy(d)).toBeNull();
    fs.chmodSync(f, 0o600); fs.writeFileSync(f, ' '.repeat(5000)); expect(readContextPolicy(d)).toBeNull();
  });
  it('does not follow a policy-file symlink', () => {
    const d = root(); const target = path.join(d, 'untrusted.json'); fs.writeFileSync(target, JSON.stringify(policy));
    fs.symlinkSync(target, path.join(d, 'next/context-policy.json')); expect(readContextPolicy(d)).toBeNull();
  });
});

describe('minimal local evidence', () => {
  it('projects timestamps and exact activity without copying text or URLs', () => {
    const c = buildLocalContext(policy, [task()], [activity()], NOW)!;
    expect(c.records).toHaveLength(2);
    expect(c.records[0]).toMatchObject({ taskId: task().id, source: 'schoology', kind: 'source-status', freshness: 'fresh', value: 'reported-open' });
    expect(c.records[1]).toMatchObject({ taskId: task().id, source: 'work-trail', kind: 'foreground-activity', freshness: 'fresh', minutes: 17 });
    const serialized = JSON.stringify(c);
    expect(serialized).not.toContain(task().title); expect(serialized).not.toContain(activity().title);
    expect(serialized).not.toContain('https://'); expect(serialized).not.toMatch(/instructions|prompt|complete"/i);
  });
  it('never confuses foreground activity with completion', () => {
    const c = buildLocalContext(policy, [task()], [activity({ minutes: 180 })], NOW)!;
    expect(c.records.find(r => r.kind === 'source-status')?.value).toBe('reported-open');
  });
  it('labels old source status stale and expires old browser evidence', () => {
    const c = buildLocalContext(policy, [task({ checkedAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() })], [activity({ lastAt: NOW.getTime() - 49 * HOUR })], NOW)!;
    expect(c.records).toHaveLength(1); expect(c.records[0].freshness).toBe('stale');
    expect(Date.parse(c.records[0].expiresAt!)).toBeLessThan(NOW.getTime());
  });
  it.each([null, 'invalid', new Date(NOW.getTime() + HOUR).toISOString()])('does not treat %s as a fresh check', checkedAt => {
    const c = buildLocalContext(policy, [task({ checkedAt })], [], NOW)!;
    expect(c.records[0]).toMatchObject({ freshness: 'unknown', observedAt: null, expiresAt: null, confidence: 'unknown' });
  });
  it('does not match on title similarity or a forged browser key', () => {
    for (const visit of [activity({ key: 'schoology:999999999', url: 'https://school.schoology.com/assignment/999999999', title: task().title }), activity({ url: 'https://evil.example/assignment/123456789' })]) {
      expect(buildLocalContext(policy, [task()], [visit], NOW)!.records.filter(r => r.source === 'work-trail')).toEqual([]);
    }
  });
  it.each([NaN, Infinity, -1, NOW.getTime() + 1])('rejects malformed or future activity timestamps (%s)', lastAt => {
    expect(buildLocalContext(policy, [task()], [activity({ lastAt })], NOW)!.records).toHaveLength(1);
  });
  it('excludes all email and honors source selection', () => {
    const mail = task({ id: 'school-mail:123456789', source: 'school-mail', taint: 'email' });
    const personal = task({ id: 'personal-mail:123456789', source: 'mail', taint: 'email' });
    expect(buildLocalContext(policy, [mail, personal], [activity()], NOW)!.records).toEqual([]);
    expect(buildLocalContext({ ...policy, sources: ['schoology'] }, [task()], [activity()], NOW)!.records).toHaveLength(1);
  });
  it('does not claim exact task identity from a site-wide activity bucket', () => {
    const url = 'https://apply.commonapp.org/common/dashboard';
    const manual = task({ id: 'task:college', source: 'manual', url });
    const visit = activity({ key: 'commonapp', kind: 'Common App', url });
    expect(buildLocalContext(policy, [manual], [visit], NOW)!.records).toEqual([]);
  });
  it('drops evidence when its task disappears and bounds the output', () => {
    expect(buildLocalContext(policy, [], [activity()], NOW)!.records).toEqual([]);
    const many = Array.from({ length: 400 }, (_, i) => task({ id: `schoology:${100000000 + i}` }));
    const c = buildLocalContext(policy, many, [], NOW)!; expect(c.records.length).toBeLessThanOrEqual(200); expect(c.truncated).toBe(true);
  });
});

describe('NextStore context path', () => {
  it('is opt-in, recomputed and independent of model-produced completion hints', () => {
    const d = root(); const store = new NextStore({ asideRoot: d, stateDir: path.join(d, 'state') });
    expect(store.plan(NOW, [activity()], [task()]).context).toBeUndefined();
    fs.writeFileSync(path.join(d, 'next/context-policy.json'), JSON.stringify(policy), { mode: 0o600 });
    store.useTransform(raws => raws.map(r => ({ ...r, resolved: true })));
    const p = store.plan(NOW, [activity()], [task()]);
    expect(p.context!.records.find(r => r.kind === 'source-status')?.value).toBe('reported-open');
    expect(store.plan(NOW, [], []).context!.records).toEqual([]);
    fs.unlinkSync(path.join(d, 'next/context-policy.json')); expect(store.plan(NOW, [], [task()]).context).toBeUndefined();
    expect(fs.existsSync(path.join(d, 'state'))).toBe(false);
  });
  it('does not resurface personal mail from a leftover or misnamed feed when disconnected', () => {
    const d = root(); fs.writeFileSync(path.join(d, 'next/config.json'), JSON.stringify({ personalMail: { enabled: false, account: 'owner@example.com' } }));
    for (const name of ['personal-mail', 'misnamed']) fs.writeFileSync(path.join(d, `next/feeds/${name}.json`), JSON.stringify({ label: 'Mail', items: [task({ id: `personal-mail:${name}`, source: 'mail', taint: 'email' })] }));
    const result = loadRaw({ asideRoot: d, stateDir: path.join(d, 'state') }, NOW);
    expect(result.raws).toEqual([]); expect(result.sources.some(s => s.id === 'personal-mail')).toBe(false);
  });
});
