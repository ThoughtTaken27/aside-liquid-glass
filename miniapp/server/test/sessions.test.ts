import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearScanCache,
  isValidSessionId,
  listSessions,
  resolveSessionDir,
  scanTranscript,
  SessionDirectoryIndex,
  sessionMsgFile,
} from '../src/sessions.js';
import { makeTestEnv, readFixture, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeEach(() => {
  clearScanCache();
  env = makeTestEnv();
  // deterministic recency: CCCC newest, then BBBB, AAAA, DDDD, subagentKid
  const order: Array<[string, number]> = [
    ['2026-01-03_subagentKid', 1_767_000_000],
    ['2026-01-06_fixtureDDDD', 1_767_100_000],
    ['2026-01-02_fixtureAAAA', 1_767_312_000],
    ['2026-01-03_fixtureBBBB', 1_767_398_400],
    ['2026-01-04_fixtureCCCC', 1_767_484_800],
  ];
  for (const [name, seconds] of order) {
    const file = path.join(env.sessionsDir, name, 'messages.jsonl');
    fs.utimesSync(file, seconds, seconds);
    fs.utimesSync(path.join(env.sessionsDir, name), seconds, seconds);
  }
});

afterEach(() => { env.cleanup(); vi.restoreAllMocks(); });

describe('session listing', () => {
  it('lists sessions newest first with titles, previews and usage', () => {
    const sessions = listSessions(env.sessionsDir);
    expect(sessions.map((s) => s.id)).toEqual([
      'fixtureCCCC',
      'fixtureBBBB',
      'fixtureAAAA',
      'fixtureDDDD',
      'subagentKid',
    ]);

    const aaaa = sessions.find((s) => s.id === 'fixtureAAAA')!;
    expect(aaaa.date).toBe('2026-01-02');
    expect(aaaa.title).toBe('Summarize the fixture plan');
    expect(aaaa.preview).toContain('fixture summary');
    expect(aaaa.turns).toBe(1);
    expect(aaaa.lastTotalTokens).toBe(1500);
    expect(aaaa.totalCost).toBeCloseTo(0.012, 6);
  });

  it('skips the identical persona seed when deriving a title', () => {
    const cccc = listSessions(env.sessionsDir).find(
      (s) => s.id === 'fixtureCCCC',
    )!;
    // first user message is the persona seed; the real one wins, and the
    // trailing "[bridge note ...]" is trimmed off
    expect(cccc.title).toBe("what's on my plate today");
    expect(cccc.turns).toBe(2);
  });

  it('honours the limit', () => {
    expect(listSessions(env.sessionsDir, 2).map((s) => s.id)).toEqual([
      'fixtureCCCC',
      'fixtureBBBB',
    ]);
  });

  it('ignores directories without a transcript', () => {
    fs.mkdirSync(path.join(env.sessionsDir, '2026-01-05_emptyDDDD'));
    expect(listSessions(env.sessionsDir).map((s) => s.id)).not.toContain(
      'emptyDDDD',
    );
  });

  it('returns an empty list for a missing sessions dir', () => {
    expect(listSessions(path.join(env.root, 'nope'))).toEqual([]);
  });

  it('reflects new activity rather than serving a stale cache', () => {
    const file = path.join(
      env.sessionsDir,
      '2026-01-02_fixtureAAAA',
      'messages.jsonl',
    );
    expect(listSessions(env.sessionsDir)[2].turns).toBe(1);
    fs.appendFileSync(
      file,
      `${JSON.stringify({ role: 'user', content: 'and one more', timestamp: 1767312100 })}\n`,
    );
    const again = listSessions(env.sessionsDir).find(
      (s) => s.id === 'fixtureAAAA',
    )!;
    expect(again.turns).toBe(2);
  });
});

describe('session resolution', () => {
  it('scans the sessions directory once for repeated id lookups', () => {
    const index = new SessionDirectoryIndex();
    const reads = vi.spyOn(fs, 'readdirSync');

    expect(index.resolve(env.sessionsDir, 'fixtureAAAA')).toContain(
      '2026-01-02_fixtureAAAA',
    );
    expect(index.resolve(env.sessionsDir, 'fixtureBBBB')).toContain(
      '2026-01-03_fixtureBBBB',
    );
    expect(index.resolve(env.sessionsDir, 'nosuchsession')).toBeNull();
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
  });

  it('refreshes its directory map after the cache window', () => {
    let now = 1_000;
    const index = new SessionDirectoryIndex(1_000, () => now);
    expect(index.resolve(env.sessionsDir, 'brandNew')).toBeNull();

    fs.mkdirSync(path.join(env.sessionsDir, '2026-08-24_brandNew'));
    now += 1_001;
    expect(index.resolve(env.sessionsDir, 'brandNew')).toContain(
      '2026-08-24_brandNew',
    );
  });

  it('resolves the short id to its dated directory', () => {
    const dir = resolveSessionDir(env.sessionsDir, 'fixtureAAAA');
    expect(dir && path.basename(dir)).toBe('2026-01-02_fixtureAAAA');
    expect(sessionMsgFile(env.sessionsDir, 'fixtureAAAA')).toContain(
      'messages.jsonl',
    );
  });

  it('refuses ids that are not opaque session tokens', () => {
    expect(isValidSessionId('../../etc')).toBe(false);
    expect(isValidSessionId('has space')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('fixtureAAAA')).toBe(true);
    expect(resolveSessionDir(env.sessionsDir, '../../etc')).toBeNull();
  });

  it('returns null for an unknown session', () => {
    expect(resolveSessionDir(env.sessionsDir, 'nosuchsession')).toBeNull();
    expect(sessionMsgFile(env.sessionsDir, 'nosuchsession')).toBeNull();
  });
});

describe('transcript scan', () => {
  it('falls back to a placeholder title when there is no user text', () => {
    const scanned = scanTranscript('');
    expect(scanned.title).toBe('(no messages)');
    expect(scanned.turns).toBe(0);
  });

  it('ignores corrupt lines while scanning', () => {
    const buffer = `not json\n${readFixture('2026-01-02_fixtureAAAA')}`;
    expect(scanTranscript(buffer).turns).toBe(1);
  });
});


describe('incremental Recents summaries', () => {
  const file = () => path.join(env.sessionsDir, '2026-01-02_fixtureAAAA', 'messages.jsonl');
  const row = () => listSessions(env.sessionsDir).find(s => s.id === 'fixtureAAAA')!;
  const user = JSON.stringify({ role: 'user', content: 'Keep this title' });
  const answer = (text: string, tokens = 10) => JSON.stringify({ role: 'assistant', content: [{type:'text', text}], usage: { totalTokens: tokens, cost: { total: 0.01 } } });
  it('reads only appended bytes and preserves original title and cumulative usage', () => {
    const fd = fs.openSync(file(), 'w');
    fs.writeSync(fd, user + '\n' + answer('Before') + '\n');
    const image = JSON.stringify({ role:'toolResult', content:[{type:'image', data:'A'.repeat(1024 * 1024)}] }) + '\n';
    for (let i = 0; i < 34; i++) fs.writeSync(fd, image);
    fs.closeSync(fd);
    expect(row().preview).toBe('Before');
    const reads = vi.spyOn(fs, 'readSync');
    const whole = vi.spyOn(fs, 'readFileSync');
    fs.appendFileSync(file(), answer('After', 20) + '\n');
    const next = row();
    expect(next.title).toBe('Keep this title');
    expect(next.preview).toBe('After');
    expect(next.turns).toBe(1);
    expect(next.lastTotalTokens).toBe(20);
    expect(next.totalCost).toBeCloseTo(0.02);
    expect(whole.mock.calls.some(call => String(call[0]) === file())).toBe(false);
    const bytes = reads.mock.results.reduce((n, r) => n + (typeof r.value === 'number' ? r.value : 0), 0);
    expect(bytes).toBeLessThan(1024);
  });
  it('shows valid unterminated lines but does not count them twice on completion', () => {
    fs.writeFileSync(file(), user + '\n' + answer('Tail'));
    expect(row().totalCost).toBeCloseTo(0.01);
    fs.appendFileSync(file(), '\n' + answer('Latest') + '\n');
    expect(row().totalCost).toBeCloseTo(0.02);
    expect(row().preview).toBe('Latest');
  });
  it('holds incomplete JSON until the complete line arrives', () => {
    const text = answer('Complete');
    fs.writeFileSync(file(), user + '\n' + text.slice(0, -8));
    expect(row().preview).toBe('');
    fs.appendFileSync(file(), text.slice(-8) + '\n');
    expect(row().preview).toBe('Complete');
    expect(row().totalCost).toBeCloseTo(0.01);
  });
  it('resets after truncate/replacement and same-size rewrite', () => {
    fs.writeFileSync(file(), user + '\n' + answer('First') + '\n');
    expect(row().preview).toBe('First');
    fs.writeFileSync(file(), user + '\n' + answer('Other') + '\n');
    const time = new Date(Date.now() + 3000); fs.utimesSync(file(), time, time);
    expect(row().preview).toBe('Other');
    expect(row().totalCost).toBeCloseTo(0.01);
    fs.writeFileSync(file() + '.new', user + '\n' + answer('Replacement') + '\n');
    fs.renameSync(file() + '.new', file());
    expect(row().preview).toBe('Replacement');
    expect(row().turns).toBe(1);
  });
  it('accepts non-leading role fields and never reads tool text as a preview', () => {
    const scanned = scanTranscript(user + '\n' + JSON.stringify({ content:[{type:'text',text:'Real answer'}], role:'assistant' }) + '\n' + JSON.stringify({role:'toolResult', content:[{type:'text',text:'Not an answer'}]}));
    expect(scanned.preview).toBe('Real answer');
    expect(scanned.turns).toBe(1);
  });
});
