/**
 * Agent-tab live view: which tab, and how frames flow.
 *
 * The browser is faked with a REPL stand-in that answers the two scripts
 * the engine sends (resolve and frame), so cadence, dedupe, backpressure,
 * tab switching and failure handling are exercised without Aside running.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { StateDb } from '../src/statedb.js';
import {
  LiveView,
  SharedRepl,
  frameScript,
  parseMarked,
  resolveScript,
  type LiveMeta,
  type ReplLike,
} from '../src/liveview.js';
import type { AgentTabCandidate } from '../src/statedb.js';

const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function agentDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-live-'));
  temps.push(dir);
  const file = path.join(dir, 'state.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_id TEXT, status TEXT, title TEXT,
    active_tab_target_id TEXT, updated_at INTEGER)`);
  db.exec(`CREATE TABLE session_tabs (id TEXT PRIMARY KEY, session_id TEXT, ownership TEXT,
    source TEXT, target_id TEXT, url TEXT, data TEXT, created_at INTEGER, updated_at INTEGER)`);
  const s = db.prepare('INSERT INTO sessions (id, parent_id, status, active_tab_target_id, updated_at) VALUES (?, ?, ?, ?, ?)');
  s.run('chat', null, 'running', 'CHAT_ACTIVE', 100);
  s.run('child-done', 'chat', 'idle', 'CHILD_OLD', 150);
  s.run('child-live', 'chat', 'running', 'CHILD_NOW', 140);
  s.run('other', null, 'idle', 'OTHER', 999);
  const t = db.prepare('INSERT INTO session_tabs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  t.run('1', 'chat', 'owned', 'open_tab', 'CHAT_ACTIVE', 'https://a.example/', '{}', 1, 100);
  t.run('2', 'chat', 'owned', 'open_tab', 'CHAT_EXTRA', 'https://b.example/', '{}', 1, 90);
  t.run('3', 'child-live', 'owned', 'open_tab', 'CHILD_NOW', 'https://c.example/', '{}', 1, 140);
  t.run('4', 'child-done', 'owned', 'open_tab', 'CHILD_OLD', 'https://d.example/', '{}', 1, 150);
  t.run('5', 'other', 'owned', 'open_tab', 'OTHER', 'https://e.example/', '{}', 1, 999);
  db.close();
  return file;
}

describe('StateDb.agentTabs', () => {
  it('puts a running subagent first, then the chat, then recent tabs', async () => {
    const tabs = await new StateDb(agentDb()).agentTabs('chat');
    expect(tabs?.map((t) => t.targetId)).toEqual([
      'CHILD_NOW',
      'CHAT_ACTIVE',
      'CHILD_OLD',
      'CHAT_EXTRA',
    ]);
    expect(tabs?.[0]).toMatchObject({ owner: 'subagent', url: 'https://c.example/' });
    expect(tabs?.[1]).toMatchObject({ owner: 'session', url: 'https://a.example/' });
  });

  it('never leaks another chat’s tabs', async () => {
    const tabs = await new StateDb(agentDb()).agentTabs('chat');
    expect(tabs?.some((t) => t.targetId === 'OTHER')).toBe(false);
  });

  it('knows nothing about an unknown chat, and null for no database', async () => {
    expect(await new StateDb(agentDb()).agentTabs('nope')).toEqual([]);
    expect(await new StateDb('/nonexistent/state.db').agentTabs('chat')).toBeNull();
  });
});

describe('scripts', () => {
  it('parses the marked line out of noisy output', () => {
    expect(parseMarked<{ a: number }>('noise\n@@LV{"a":1}\n[ok | 3ms]')).toEqual({ a: 1 });
    expect(() => parseMarked('Error: boom')).toThrow(/boom/);
  });

  it('embeds ids as literals, never raw', () => {
    const evil = 'x"); process.exit(1); ("';
    expect(frameScript(evil, 50)).toContain(JSON.stringify(evil));
    expect(resolveScript([evil])).toContain(JSON.stringify([evil]));
  });
});

/** A browser with a set of open tabs whose pictures can be changed. */
function fakeBrowser(open: Record<string, string>) {
  const pictures: Record<string, string> = { ...open };
  let calls = 0;
  let broken = false;
  const repl: ReplLike = {
    alive: true,
    async run(code: string) {
      calls += 1;
      if (broken) throw new Error('browser gone');
      if (code.includes('listBrowserTabs')) {
        const want = JSON.parse(code.match(/const want = (\[.*?\]);/)![1]) as string[];
        const hit = want.find((id) => id in pictures);
        return hit
          ? `@@LV${JSON.stringify({ targetId: hit, url: `https://${hit}.example/`, title: hit, faviconUrl: '' })}`
          : '@@LV{"none":true}';
      }
      const id = JSON.parse(code.match(/lv\[(".*?")\]/)![1]) as string;
      if (!(id in pictures)) throw new Error('tab closed');
      return `@@LV${JSON.stringify({ u: `https://${id}.example/`, b: Buffer.from(pictures[id]).toString('base64') })}`;
    },
    close() {},
  };
  return {
    repl,
    set(id: string, picture: string) {
      pictures[id] = picture;
    },
    closeTab(id: string) {
      delete pictures[id];
    },
    breakIt() {
      broken = true;
    },
    get calls() {
      return calls;
    },
  };
}

/** Drive the engine's naps by hand: each tick releases every pending sleep. */
function manualClock() {
  let now = 1_000;
  let waiting: Array<() => void> = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        waiting.push(() => {
          now += ms;
          resolve();
        });
      }),
    async tick(times = 1) {
      for (let i = 0; i < times; i++) {
        const batch = waiting;
        waiting = [];
        batch.forEach((fn) => fn());
        for (let j = 0; j < 20; j++) await Promise.resolve();
      }
    },
  };
}

function sink(congested = () => false) {
  const frames: string[] = [];
  const metas: LiveMeta[] = [];
  return {
    frames,
    metas,
    sink: { frame: (b: Buffer) => frames.push(b.toString()), meta: (m: LiveMeta) => metas.push(m), congested },
  };
}

const cand = (targetId: string, owner: 'session' | 'subagent' = 'session'): AgentTabCandidate => ({
  targetId,
  sessionId: 'chat',
  owner,
  url: '',
  at: 1,
});

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

describe('LiveView', () => {
  it('streams the agent tab and sends only frames that changed', async () => {
    const browser = fakeBrowser({ T1: 'frame-a' });
    const clock = manualClock();
    const view = new LiveView({ tabs: async () => [cand('T1')], openRepl: async () => browser.repl, ...clock });
    const s = sink();
    view.watch('chat', s.sink, { stream: true });
    await settle();
    expect(s.metas.at(-1)).toMatchObject({ state: 'live', tab: { targetId: 'T1', title: 'T1' } });
    expect(s.frames).toEqual(['frame-a']);

    await clock.tick(3);
    await settle();
    expect(s.frames).toEqual(['frame-a']); // unchanged picture is not re-sent

    browser.set('T1', 'frame-b');
    await clock.tick(2);
    await settle();
    expect(s.frames).toEqual(['frame-a', 'frame-b']);
    view.close();
  });

  it('never captures when nobody asked for frames', async () => {
    const browser = fakeBrowser({ T1: 'frame-a' });
    const clock = manualClock();
    const view = new LiveView({ tabs: async () => [cand('T1')], openRepl: async () => browser.repl, ...clock });
    const s = sink();
    const handle = view.watch('chat', s.sink, { stream: false });
    await settle();
    expect(s.metas.at(-1)).toMatchObject({ state: 'ready' });
    expect(s.frames).toEqual([]);

    handle.update({ stream: true });
    await settle();
    await clock.tick(1);
    await settle();
    expect(s.frames).toEqual(['frame-a']);
    expect(s.metas.at(-1)).toMatchObject({ state: 'live' });
    view.close();
  });

  it('does not start the browser helper for a chat that never browsed', async () => {
    let opened = 0;
    const clock = manualClock();
    const view = new LiveView({
      tabs: async () => [],
      openRepl: async () => {
        opened += 1;
        return fakeBrowser({}).repl;
      },
      ...clock,
    });
    const s = sink();
    view.watch('chat', s.sink, { stream: true });
    await settle();
    expect(s.metas.at(-1)).toMatchObject({ state: 'no_tab', tab: null });
    expect(opened).toBe(0);
    view.close();
  });

  it('skips a stored tab that is no longer open', async () => {
    const browser = fakeBrowser({ T2: 'second' });
    const clock = manualClock();
    const view = new LiveView({
      tabs: async () => [cand('GONE'), cand('T2', 'subagent')],
      openRepl: async () => browser.repl,
      ...clock,
    });
    const s = sink();
    view.watch('chat', s.sink, { stream: true });
    await settle();
    expect(s.metas.at(-1)).toMatchObject({ state: 'live', tab: { targetId: 'T2', owner: 'subagent' } });
    expect(s.frames).toEqual(['second']);
    view.close();
  });

  it('reports no tab once the agent’s tab closes', async () => {
    const browser = fakeBrowser({ T1: 'frame-a' });
    const clock = manualClock();
    const view = new LiveView({ tabs: async () => [cand('T1')], openRepl: async () => browser.repl, ...clock });
    const s = sink();
    view.watch('chat', s.sink, { stream: true });
    await settle();
    browser.closeTab('T1');
    await clock.tick(2);
    await settle();
    await clock.tick(2);
    await settle();
    expect(s.metas.at(-1)).toMatchObject({ state: 'no_tab', tab: null });
    view.close();
  });

  it('holds frames back from a congested viewer', async () => {
    const browser = fakeBrowser({ T1: 'frame-a' });
    const clock = manualClock();
    const view = new LiveView({ tabs: async () => [cand('T1')], openRepl: async () => browser.repl, ...clock });
    const s = sink(() => true);
    view.watch('chat', s.sink, { stream: true });
    await settle();
    await clock.tick(3);
    await settle();
    expect(s.frames).toEqual([]);
    view.close();
  });

  it('says unavailable instead of guessing when the browser fails', async () => {
    const browser = fakeBrowser({ T1: 'frame-a' });
    browser.breakIt();
    const clock = manualClock();
    const view = new LiveView({
      tabs: async () => [cand('T1')],
      openRepl: async () => browser.repl,
      logger: { warn: () => {} },
      ...clock,
    });
    const s = sink();
    view.watch('chat', s.sink, { stream: true });
    await settle();
    expect(s.metas.at(-1)).toMatchObject({ state: 'unavailable', tab: null });
    view.close();
  });

  it('gives a late viewer the current picture immediately', async () => {
    const browser = fakeBrowser({ T1: 'frame-a' });
    const clock = manualClock();
    const view = new LiveView({ tabs: async () => [cand('T1')], openRepl: async () => browser.repl, ...clock });
    view.watch('chat', sink().sink, { stream: true });
    await settle();
    const late = sink();
    view.watch('chat', late.sink, { stream: true });
    expect(late.frames).toEqual(['frame-a']);
    expect(late.metas.at(-1)).toMatchObject({ state: 'live' });
    view.close();
  });
});

describe('StateDb.tabOwners', () => {
  it('credits a subagent tab to its parent chat and marks running work', async () => {
    const owners = await new StateDb(agentDb()).tabOwners();
    expect(owners.get('CHILD_NOW')).toEqual({ sessionId: 'chat', title: '', running: true });
    expect(owners.get('CHAT_EXTRA')).toMatchObject({ sessionId: 'chat', running: true });
    expect(owners.get('OTHER')).toMatchObject({ sessionId: 'other', running: false });
    expect(owners.has('NOT_A_TAB')).toBe(false);
  });

  it('is empty, not an error, without a database', async () => {
    expect((await new StateDb('/nonexistent/state.db').tabOwners()).size).toBe(0);
  });
});

describe('helper sessions', () => {
  it('never lists a tab a REPL only looked at as an agent tab', async () => {
    const file = agentDb();
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO sessions (id, parent_id, status, title, active_tab_target_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('helper', null, 'idle', 'Aside CLI REPL', null, 500);
    db.prepare('INSERT INTO session_tabs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('9', 'helper', 'borrowed', 'attachment', 'VIEWED', 'https://x.com/', '{}', 1, 500);
    db.close();
    const owners = await new StateDb(file).tabOwners();
    expect(owners.has('VIEWED')).toBe(false);
    expect(owners.has('CHAT_ACTIVE')).toBe(true);
  });

  it('archives its own Aside session when the helper shuts down', async () => {
    const calls: string[] = [];
    let closed = false;
    const shared = new SharedRepl(async () => ({
      alive: true,
      async run(code: string) {
        calls.push(code);
        return code.includes('sessions.current') ? '@@LV"helper-1"' : '';
      },
      close() {
        closed = true;
      },
    }));
    await shared.run('1');
    expect(shared.helperId).toBe('helper-1');
    shared.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.includes('aside.sessions.archive("helper-1")'))).toBe(true);
    expect(closed).toBe(true);
  });
});
