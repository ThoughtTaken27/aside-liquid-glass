/**
 * The desktop-style queue: messages sent mid-turn wait as visible cards,
 * can be removed or steered in, are held behind a turn the Mac owns, and
 * carry the follow-up reminder exactly once per turn.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnRunner, type QueueChange } from '../src/exec.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  activity = new PassThrough();
  stdio = [null, this.stdout, this.stderr, this.activity];
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill(): boolean { this.finish(null); return true; }
  finish(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? -1;
    this.emit('close', code);
  }
}

let env: TestEnv;
let spawned: Array<{ args: string[]; child: FakeChild }>;
let controlExit = 0;
let runners: TurnRunner[] = [];

function makeRunner(overrides: Record<string, unknown> = {}): TurnRunner {
  const runner = new TurnRunner({
    asideCli: '/fake/aside',
    sessionsDir: env.sessionsDir,
    execTimeoutMs: 5_000,
    defaultModel: 'm',
    defaultEffort: 'high',
    modelAliases: {},
    spawnFn: (_cmd: string, args: string[]) => {
      const child = new FakeChild();
      spawned.push({ args: [...args], child });
      // Session-control commands (stop/steer) acknowledge on the next tick.
      if (args[0] === 'session' && args[1] !== 'resume') {
        setTimeout(() => child.finish(controlExit), 0);
      }
      return child;
    },
    ...overrides,
  } as any);
  runners.push(runner);
  return runner;
}

const turns = () => spawned.filter((s) => s.args.includes('resume'));
const msg = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  model: 'm',
  effort: 'low' as const,
  display: { text },
  ...extra,
});

beforeEach(() => {
  env = makeTestEnv();
  spawned = [];
  controlExit = 0;
});
afterEach(() => { runners.splice(0).forEach(runner => runner.shutdown()); env.cleanup(); });

describe('queued messages', () => {
  it('runs immediately when idle and reports held=false', () => {
    const runner = makeRunner();
    const res = runner.send('s', msg('hello'));
    expect(res.held).toBe(false);
    expect(turns()).toHaveLength(1);
    expect(runner.queuedItems('s')).toEqual([]);
  });

  it('holds a mid-turn message as a visible card with the typed words only', () => {
    const runner = makeRunner();
    const events: QueueChange[] = [];
    runner.on('queue', (e) => events.push(e));
    runner.send('s', msg('first'));
    const res = runner.send('s', msg('second', { text: 'second + plumbing' }));
    expect(res.held).toBe(true);
    const items = runner.queuedItems('s');
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('second');
    expect(items[0].id).toBe(res.id);
    expect(events.at(-1)?.items).toHaveLength(1);
  });

  it('dispatches the queue when the turn ends and reports what left', () => {
    const runner = makeRunner();
    const events: QueueChange[] = [];
    runner.on('queue', (e) => events.push(e));
    runner.send('s', msg('first'));
    runner.send('s', msg('second'));
    runner.send('s', msg('third'));
    turns()[0].child.finish(0);
    expect(turns()).toHaveLength(2);
    expect(turns()[1].args.at(-1)).toBe('second\n\nthird');
    const last = events.at(-1)!;
    expect(last.items).toEqual([]);
    expect(last.dispatched?.map((d) => d.text)).toEqual(['second', 'third']);
  });

  it('wraps a batched prompt once, at the end', () => {
    const runner = makeRunner();
    const wrap = (t: string) => `${t}\n\n[R]`;
    runner.send('s', msg('first', { wrap }));
    runner.send('s', msg('a', { wrap }));
    runner.send('s', msg('b', { wrap }));
    expect(turns()[0].args.at(-1)).toBe('first\n\n[R]');
    turns()[0].child.finish(0);
    expect(turns()[1].args.at(-1)).toBe('a\n\nb\n\n[R]');
  });

  it('removes a waiting message so it never runs', () => {
    const runner = makeRunner();
    runner.send('s', msg('first'));
    const { id } = runner.send('s', msg('oops'));
    expect(runner.dequeue('s', id)?.text).toBe('oops');
    expect(runner.dequeue('s', id)).toBeNull();
    turns()[0].child.finish(0);
    expect(turns()).toHaveLength(1);
  });

  it('Stop drops the queue and hands the words back as dropped', () => {
    const runner = makeRunner();
    const events: QueueChange[] = [];
    runner.on('queue', (e) => events.push(e));
    runner.send('s', msg('first'));
    runner.send('s', msg('keep me'));
    expect(runner.stop('s')).toBe(true);
    expect(events.at(-1)?.dropped?.map((d) => d.text)).toEqual(['keep me']);
    expect(runner.queuedItems('s')).toEqual([]);
    expect(turns()).toHaveLength(1);
  });
});

describe('steer', () => {
  it('calls the sanctioned CLI command with the prompt after --', async () => {
    const runner = makeRunner();
    await expect(runner.steer('s', '-dash leading')).resolves.toBe(true);
    const call = spawned.find((s) => s.args[1] === 'steer')!;
    expect(call.args).toEqual(['session', 'steer', 's', '--', '-dash leading']);
  });

  it('reports a refused steer, and requeueFront puts the message back first', async () => {
    controlExit = 1;
    const runner = makeRunner();
    runner.send('s', msg('first'));
    const a = runner.send('s', msg('a'));
    runner.send('s', msg('b'));
    const item = runner.dequeue('s', a.id)!;
    await expect(runner.steer('s', item.text)).resolves.toBe(false);
    runner.requeueFront('s', item);
    expect(runner.queuedItems('s').map((q) => q.text)).toEqual(['a', 'b']);
  });
});

describe('holding behind a desktop-owned turn', () => {
  it('waits while the daemon says running, then sends', async () => {
    vi.useFakeTimers();
    try {
      let status = 'running';
      const runner = makeRunner({
        holdWhileRunning: true,
        holdPollMs: 100,
        readStatus: async () => status,
      });
      const res = runner.send('s', msg('while mac works'));
      await vi.advanceTimersByTimeAsync(0);
      expect(turns()).toHaveLength(0);
      expect(runner.queuedItems('s').map((q) => q.id)).toEqual([res.id]);
      await vi.advanceTimersByTimeAsync(350);
      expect(turns()).toHaveLength(0);
      status = 'idle';
      await vi.advanceTimersByTimeAsync(150);
      expect(turns()).toHaveLength(1);
      expect(runner.queuedItems('s')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends at once to an idle session', async () => {
    const runner = makeRunner({ holdWhileRunning: true, readStatus: async () => 'idle' });
    runner.send('s', msg('go'));
    await new Promise((r) => setTimeout(r, 0));
    expect(turns()).toHaveLength(1);
  });

  it('dropQueued clears a held queue (desktop stop)', async () => {
    const runner = makeRunner({ holdWhileRunning: true, holdPollMs: 50, readStatus: async () => 'running' });
    runner.send('s', msg('held'));
    await new Promise((r) => setTimeout(r, 0));
    runner.dropQueued('s');
    expect(runner.queuedItems('s')).toEqual([]);
    await new Promise((r) => setTimeout(r, 120));
    expect(turns()).toHaveLength(0);
  });
});

describe('isHeld', () => {
  it('waits for the hold check before answering', async () => {
    let status = 'running';
    const runner = makeRunner({ holdWhileRunning: true, holdPollMs: 50, readStatus: async () => status });
    const res = runner.send('s', msg('x'));
    expect(res.held).toBe(false);
    await expect(runner.isHeld('s', res.id)).resolves.toBe(true);
    status = 'idle';
    const idle = makeRunner({ holdWhileRunning: true, readStatus: async () => 'idle' });
    const r2 = idle.send('t', msg('y'));
    await expect(idle.isHeld('t', r2.id)).resolves.toBe(false);
    runner.dropQueued('s');
  });
});
