/**
 * Live view of the tab a chat's agent is working in.
 *
 * The old Watch Mode screenshotted whichever tab happened to be focused on
 * the Mac, spawning a fresh ~139MB `aside repl` process per frame, every
 * 3-10 seconds. So the phone saw a random tab, rarely, at real cost.
 *
 * This module fixes all three:
 *
 *  - WHICH tab: `StateDb.agentTabs()` reads the daemon's own record of the
 *    tabs this chat (or a running subagent of it) drives, and each
 *    candidate is confirmed against the live browser before it is shown.
 *  - HOW: one long-lived `aside mcp` process whose REPL scope persists.
 *    The tab is attached once and every later frame is a single
 *    `page.screenshot()` round trip: ~30ms instead of ~700ms plus a spawn.
 *  - HOW OFTEN: up to 5 frames a second while the page changes, easing to
 *    one a second when it is still. Identical frames are never re-sent, and
 *    a viewer whose socket is backed up is skipped until it drains, so a
 *    slow phone link lowers the frame rate instead of queueing seconds of
 *    stale video.
 *
 * The REPL process is started on the first viewer that has a real
 * candidate tab and stopped after IDLE_STOP_MS with none.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AgentTabCandidate } from './statedb.js';

/** What the phone is told about the tab it is (or would be) watching. */
export interface LiveTab {
  targetId: string;
  url: string;
  title: string;
  faviconUrl: string;
  owner: 'session' | 'subagent';
}

export type LiveState =
  /** Frames are flowing (or will as soon as the page paints). */
  | 'live'
  /** A tab is known and open, but nobody asked for frames. */
  | 'ready'
  /** This chat's agent has no open tab. */
  | 'no_tab'
  /** The browser could not be reached. */
  | 'unavailable';

export interface LiveMeta {
  type: 'live_tab';
  sessionId: string;
  state: LiveState;
  tab: LiveTab | null;
}

export interface LiveSink {
  frame(jpeg: Buffer): void;
  meta(event: LiveMeta): void;
  /** True while this viewer's socket still has a backlog to flush. */
  congested(): boolean;
}

export type LiveQuality = 'card' | 'full';

export interface LiveHandle {
  update(opts: { stream: boolean; quality?: LiveQuality }): void;
  close(): void;
}

/** A persistent REPL. `run` returns the text the code printed. */
export interface ReplLike {
  run(code: string, timeoutMs?: number): Promise<string>;
  close(): void;
  readonly alive: boolean;
}

export interface LiveViewOptions {
  tabs: (sessionId: string) => Promise<AgentTabCandidate[] | null>;
  /** A factory (tests) or an existing shared REPL (the server). */
  openRepl?: () => Promise<ReplLike>;
  repl?: SharedRepl;
  /** Seam for tests: resolves after `ms`. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn(msg: string): void; info?(msg: string): void };
}

const MARK = '@@LV';
export const FAST_FRAME_MS = 200;
export const SETTLED_FRAME_MS = 500;
export const STILL_FRAME_MS = 1_000;
export const RESOLVE_EVERY_MS = 2_500;
export const IDLE_STOP_MS = 60_000;
const QUALITY: Record<LiveQuality, number> = { card: 50, full: 68 };
/** Favicons can be inlined as data URLs; only small ones are worth forwarding. */
const MAX_FAVICON_CHARS = 4_096;

function lit(value: unknown): string {
  return JSON.stringify(value);
}

/** Pull the one marked JSON line out of whatever the REPL printed. */
export function parseMarked<T>(text: string): T {
  const at = text.lastIndexOf(MARK);
  if (at < 0) throw new Error(text.trim().slice(0, 200) || 'no output');
  const rest = text.slice(at + MARK.length);
  const end = rest.indexOf('\n');
  return JSON.parse(end < 0 ? rest : rest.slice(0, end)) as T;
}

export function resolveScript(targetIds: string[]): string {
  return `await (async () => {
  const want = ${lit(targetIds)};
  const rows = await listBrowserTabs();
  const byId = new Map(rows.map((r) => [r.targetId, r]));
  const hit = want.find((id) => byId.has(id));
  if (!hit) { console.log(${lit(MARK)} + JSON.stringify({ none: true })); return; }
  const r = byId.get(hit);
  const fav = String(r.faviconUrl || '');
  console.log(${lit(MARK)} + JSON.stringify({
    targetId: hit,
    url: String(r.url || ''),
    title: String(r.title || ''),
    faviconUrl: fav.startsWith('data:') && fav.length > ${MAX_FAVICON_CHARS} ? '' : fav,
  }));
})();`;
}

export function frameScript(targetId: string, quality: number): string {
  return `await (async () => {
  const lv = (globalThis.__asideLive ||= {});
  let p = lv[${lit(targetId)}];
  if (!p || (typeof p.isClosed === 'function' && p.isClosed())) {
    p = lv[${lit(targetId)}] = await attachBrowserTab(${lit(targetId)});
  }
  const b = await p.screenshot({ type: 'jpeg', quality: ${quality} });
  console.log(${lit(MARK)} + JSON.stringify({ u: p.url(), b: b.toString('base64') }));
})();`;
}

interface Viewer {
  sink: LiveSink;
  stream: boolean;
  quality: LiveQuality;
}

class Channel {
  readonly viewers = new Set<Viewer>();
  tab: LiveTab | null = null;
  state: LiveState = 'no_tab';
  lastFrame: Buffer | null = null;
  lastHash = '';
  unchanged = 0;
  lastResolve = 0;
  running = false;
  wake: (() => void) | null = null;
  failures = 0;
  /** Whether any meta has gone out yet; the first resolve always announces. */
  announced = false;

  constructor(readonly sessionId: string) {}

  streaming(): Viewer[] {
    return [...this.viewers].filter((v) => v.stream);
  }

  quality(): number {
    return this.streaming().some((v) => v.quality === 'full') ? QUALITY.full : QUALITY.card;
  }

  metaFor(): LiveMeta {
    const state: LiveState =
      this.tab && this.state !== 'unavailable'
        ? this.streaming().length ? 'live' : 'ready'
        : this.state;
    return { type: 'live_tab', sessionId: this.sessionId, state, tab: this.tab };
  }
}

/**
 * One warm `aside mcp` REPL shared by everything that reads the browser:
 * the live view and the tab list. Started on first use, stopped after
 * IDLE_STOP_MS without a caller, restarted transparently if it dies.
 */
export class SharedRepl {
  private repl: ReplLike | null = null;
  private starting: Promise<ReplLike> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private holds = 0;

  constructor(
    private readonly open: () => Promise<ReplLike>,
    private readonly idleMs = IDLE_STOP_MS,
  ) {}

  /** True when a call would not pay the multi-second process start. */
  get warm(): boolean {
    return Boolean(this.repl?.alive);
  }

  /** Start the process in the background if it is not running. */
  warmUp(): void {
    if (this.warm || this.starting) return;
    void this.ensure()
      .then(() => this.touch())
      .catch(() => undefined);
  }

  async run(code: string, timeoutMs?: number): Promise<string> {
    const repl = await this.ensure();
    this.touch();
    return repl.run(code, timeoutMs);
  }

  /** Keep the process alive while something is streaming. */
  hold(): () => void {
    this.holds += 1;
    this.cancelIdle();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      this.touch();
    };
  }

  close(): void {
    this.cancelIdle();
    this.retire(this.repl);
    this.repl = null;
  }

  /**
   * `aside mcp` registers itself as an Aside session ("Aside CLI REPL")
   * and borrows every tab it attaches. Archive that session when the
   * process is done with it, so helpers never pile up in Aside, then stop.
   */
  private retire(repl: ReplLike | null): void {
    if (!repl) return;
    const id = this.helperId;
    this.helperId = null;
    if (!id || !repl.alive) {
      repl.close();
      return;
    }
    void repl
      .run(`try { aside.sessions.archive(${lit(id)}); } catch {}`, 3_000)
      .catch(() => undefined)
      .finally(() => repl.close());
  }

  /** The helper's own Aside session id, when known. */
  helperId: string | null = null;

  private async ensure(): Promise<ReplLike> {
    if (this.repl?.alive) return this.repl;
    if (this.starting) return this.starting;
    this.starting = this.open()
      .then(async (repl) => {
        this.repl = repl;
        try {
          const out = await repl.run(
            `console.log(${lit(MARK)} + JSON.stringify(aside.sessions.current()?.id ?? null));`,
            5_000,
          );
          const id = parseMarked<string | null>(out);
          this.helperId = typeof id === 'string' && id ? id : null;
        } catch {
          this.helperId = null;
        }
        return repl;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private touch(): void {
    if (this.holds > 0) return;
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.holds > 0) return;
      this.retire(this.repl);
      this.repl = null;
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

export class LiveView {
  private channels = new Map<string, Channel>();
  private readonly repl: SharedRepl;
  private release: (() => void) | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly opts: LiveViewOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
    this.now = opts.now ?? Date.now;
    const open = opts.openRepl;
    this.repl =
      opts.repl ??
      new SharedRepl(open ?? (() => Promise.reject(new Error('no browser REPL configured'))));
  }

  /** Start watching a chat. Meta always flows; frames only while `stream`. */
  watch(sessionId: string, sink: LiveSink, opts: { stream?: boolean; quality?: LiveQuality } = {}): LiveHandle {
    let channel = this.channels.get(sessionId);
    if (!channel) {
      channel = new Channel(sessionId);
      this.channels.set(sessionId, channel);
    }
    const ch = channel;
    const viewer: Viewer = { sink, stream: Boolean(opts.stream), quality: opts.quality ?? 'card' };
    ch.viewers.add(viewer);
    if (!this.release) this.release = this.repl.hold();

    // A late joiner gets the current picture at once instead of waiting
    // for the page to change.
    if (ch.announced) sink.meta(ch.metaFor());
    if (viewer.stream && ch.lastFrame) sink.frame(ch.lastFrame);
    this.kick(ch);

    return {
      update: ({ stream, quality }) => {
        const was = viewer.stream;
        viewer.stream = stream;
        if (quality) viewer.quality = quality;
        if (stream !== was && ch.announced) this.broadcastMeta(ch);
        if (stream && !was) {
          if (ch.lastFrame) sink.frame(ch.lastFrame);
          ch.lastResolve = 0; // confirm the tab is still there right away
        }
        this.kick(ch);
      },
      close: () => {
        ch.viewers.delete(viewer);
        if (!ch.viewers.size) {
          this.channels.delete(sessionId);
          ch.wake?.();
        }
        if (!this.channels.size) {
          this.release?.();
          this.release = null;
        }
      },
    };
  }

  /** Stop everything; used on server shutdown. */
  close(): void {
    this.stopped = true;
    for (const ch of this.channels.values()) ch.wake?.();
    this.channels.clear();
    this.release?.();
    this.release = null;
  }

  private kick(ch: Channel): void {
    if (ch.running) {
      ch.wake?.();
      return;
    }
    ch.running = true;
    void this.loop(ch).finally(() => {
      ch.running = false;
    });
  }

  private broadcastMeta(ch: Channel): void {
    const meta = ch.metaFor();
    for (const v of ch.viewers) v.sink.meta(meta);
  }

  /** Sleep that a new viewer, a stream toggle or a close can cut short. */
  private nap(ch: Channel, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        ch.wake = null;
        resolve();
      };
      ch.wake = finish;
      void this.sleep(ms).then(finish);
    });
  }

  private alive(ch: Channel): boolean {
    return !this.stopped && this.channels.get(ch.sessionId) === ch && ch.viewers.size > 0;
  }

  private async loop(ch: Channel): Promise<void> {
    while (this.alive(ch)) {
      if (!ch.lastResolve || this.now() - ch.lastResolve >= RESOLVE_EVERY_MS) {
        await this.resolve(ch);
        if (!this.alive(ch)) return;
      }

      const watchers = ch.streaming();
      if (!watchers.length || !ch.tab) {
        await this.nap(ch, RESOLVE_EVERY_MS);
        continue;
      }
      if (watchers.every((v) => v.sink.congested())) {
        await this.nap(ch, 120);
        continue;
      }

      const began = this.now();
      try {
        const out = await this.repl.run(frameScript(ch.tab.targetId, ch.quality()), 10_000);
        const shot = parseMarked<{ u?: string; b?: string }>(out);
        if (!shot.b) throw new Error('empty frame');
        const jpeg = Buffer.from(shot.b, 'base64');
        const hash = createHash('sha1').update(jpeg).digest('hex');
        ch.failures = 0;
        if (shot.u && shot.u !== ch.tab.url) {
          ch.tab = { ...ch.tab, url: shot.u };
          this.broadcastMeta(ch);
        }
        if (hash !== ch.lastHash) {
          ch.lastHash = hash;
          ch.lastFrame = jpeg;
          ch.unchanged = 0;
          for (const v of ch.streaming()) if (!v.sink.congested()) v.sink.frame(jpeg);
        } else {
          ch.unchanged += 1;
        }
      } catch (err) {
        ch.failures += 1;
        // Most often the tab closed or navigated away from its target.
        // Re-resolve now; back off if the browser itself is the problem.
        ch.lastResolve = 0;
        if (ch.failures >= 3) {
          this.opts.logger?.warn(`[live] frame failed: ${(err as Error).message}`);
          await this.nap(ch, Math.min(8_000, 1_000 * ch.failures));
          continue;
        }
      }

      const cadence =
        ch.unchanged >= 30 ? STILL_FRAME_MS : ch.unchanged >= 8 ? SETTLED_FRAME_MS : FAST_FRAME_MS;
      const spent = this.now() - began;
      await this.nap(ch, Math.max(30, cadence - spent));
    }
  }

  private async resolve(ch: Channel): Promise<void> {
    const first = !ch.lastResolve && !ch.announced;
    ch.lastResolve = this.now();
    const before = JSON.stringify(ch.metaFor());
    try {
      const candidates = await this.opts.tabs(ch.sessionId);
      if (candidates === null) {
        ch.state = 'unavailable';
        ch.tab = null;
      } else if (!candidates.length) {
        // Nothing to confirm, so the browser is not even asked. Most chats
        // never browse and never start the REPL process.
        ch.state = 'no_tab';
        ch.tab = null;
      } else {
        const found = parseMarked<{
          none?: boolean;
          targetId?: string;
          url?: string;
          title?: string;
          faviconUrl?: string;
        }>(await this.repl.run(resolveScript(candidates.map((c) => c.targetId)), 10_000));
        if (found.none || !found.targetId) {
          ch.state = 'no_tab';
          ch.tab = null;
        } else {
          const owner = candidates.find((c) => c.targetId === found.targetId)?.owner ?? 'session';
          if (ch.tab?.targetId !== found.targetId) {
            ch.lastHash = '';
            ch.lastFrame = null;
            ch.unchanged = 0;
          }
          ch.state = 'live';
          ch.tab = {
            targetId: found.targetId,
            url: found.url || '',
            title: found.title || '',
            faviconUrl: found.faviconUrl || '',
            owner,
          };
        }
      }
    } catch (err) {
      ch.state = 'unavailable';
      ch.tab = null;
      this.opts.logger?.warn(`[live] resolve failed: ${(err as Error).message}`);
    }
    if (first || JSON.stringify(ch.metaFor()) !== before) {
      ch.announced = true;
      this.broadcastMeta(ch);
    }
  }
}

/**
 * The real REPL: `aside mcp` speaking JSON-RPC over stdio, with the `repl`
 * tool whose scope persists between calls. Calls are serialized.
 */
export async function openMcpRepl(asideCli: string): Promise<ReplLike> {
  const child = spawn(asideCli, ['mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let alive = true;
  let buffer = '';
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  const fail = (why: string) => {
    alive = false;
    for (const p of pending.values()) p.reject(new Error(why));
    pending.clear();
  };
  child.on('exit', () => fail('aside mcp exited'));
  child.on('error', (err) => fail(err.message));
  child.stdin.on('error', () => fail('aside mcp stdin closed'));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = typeof msg?.id === 'number' ? pending.get(msg.id) : undefined;
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(String(msg.error.message || 'mcp error')));
      else waiter.resolve(msg.result);
    }
  });

  const rpc = (method: string, params: unknown, timeoutMs = 15_000) =>
    new Promise<any>((resolve, reject) => {
      if (!alive) {
        reject(new Error('aside mcp is not running'));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aside-mobile-live', version: '1' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  } catch (err) {
    child.kill();
    throw err;
  }

  let chain: Promise<unknown> = Promise.resolve();
  return {
    get alive() {
      return alive;
    },
    run(code, timeoutMs = 15_000) {
      const next = chain.then(async () => {
        const result = await rpc(
          'tools/call',
          { name: 'repl', arguments: { code, title: 'Mobile live view' } },
          timeoutMs,
        );
        const text = Array.isArray(result?.content)
          ? result.content.map((c: { text?: string }) => c.text || '').join('')
          : '';
        if (result?.isError) throw new Error(text.slice(0, 200) || 'repl error');
        return text;
      });
      chain = next.catch(() => undefined);
      return next;
    },
    close() {
      alive = false;
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      child.kill();
    },
  };
}
