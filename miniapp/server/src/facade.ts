/**
 * The sanctioned Aside CLI facade.
 *
 * `aside repl "<js>"` evaluates JavaScript against the running Aside
 * daemon and prints whatever the script logs. That is the supported way to
 * reach real session metadata -- titles, status, read state, structured
 * transcripts -- none of which can be derived faithfully from the raw
 * messages.jsonl on disk.
 *
 * Two things make the transport fiddly and are handled here once:
 *
 *  - The CLI appends its own ANSI-coloured `[ok | 12ms]` trailer to
 *    stdout, so raw stdout is never valid JSON. We wrap every payload in
 *    sentinels rather than guessing which line is ours.
 *  - Each call spawns a ~139MB binary. Results are therefore cached with a
 *    short TTL and identical in-flight calls are coalesced.
 */
import { execFile } from 'node:child_process';

const BEGIN = '<<<ASIDE_JSON';
const END = 'ASIDE_JSON>>>';

export interface FacadeOptions {
  asideCli: string;
  timeoutMs?: number;
  /** Injected in tests so the cache can be exercised without spawning. */
  runFn?: (expression: string) => Promise<unknown>;
}

export class FacadeError extends Error {
  constructor(
    message: string,
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'FacadeError';
  }
}

/**
 * Pull our payload out of the CLI's chatty stdout.
 *
 * Exported because the sentinel contract is exactly the sort of thing that
 * breaks silently on a CLI upgrade, so it is covered directly by tests.
 */
export function parseFacadeOutput(stdout: string): unknown {
  const start = stdout.indexOf(BEGIN);
  const end = stdout.indexOf(END, start + BEGIN.length);
  if (start === -1 || end === -1) {
    throw new FacadeError(
      `aside repl produced no payload (stdout: ${stdout.slice(0, 200)})`,
    );
  }
  const json = stdout.slice(start + BEGIN.length, end);
  try {
    return JSON.parse(json) as unknown;
  } catch (err) {
    throw new FacadeError(
      `aside repl payload was not JSON: ${(err as Error).message}`,
    );
  }
}

/**
 * Evaluate `expression` (an async-capable JS expression) in the daemon and
 * return its JSON value.
 */
export function runFacade(
  opts: FacadeOptions,
  expression: string,
): Promise<unknown> {
  // `undefined` is not valid JSON; null keeps the sentinel parse total.
  const script =
    `const __v = await (async () => (${expression}))();` +
    `console.log(${JSON.stringify(BEGIN)} + JSON.stringify(__v ?? null) + ${JSON.stringify(END)});`;

  return new Promise((resolve, reject) => {
    execFile(
      opts.asideCli,
      ['repl', script],
      {
        timeout: opts.timeoutMs ?? 20_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err && !stdout.includes(BEGIN)) {
          reject(
            new FacadeError(
              `aside repl failed: ${err.message}`,
              String(stderr).slice(0, 500),
            ),
          );
          return;
        }
        try {
          resolve(parseFacadeOutput(String(stdout)));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

interface CacheEntry {
  at: number;
  value: unknown;
}

/**
 * TTL cache with in-flight coalescing.
 *
 * Both halves matter: the TTL stops a polling client from spawning a
 * process per request, and the in-flight map stops a burst of concurrent
 * requests (the WS reconnect storm after a phone unlocks, typically) from
 * spawning several at once for the same key.
 */
/** Bounded: the key is per-session, and there are thousands of sessions. */
const MAX_FACADE_ENTRIES = 256;

export class FacadeCache {
  private entries = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private opts: FacadeOptions,
    private now: () => number = Date.now,
  ) {}

  private run(expression: string): Promise<unknown> {
    return this.opts.runFn
      ? this.opts.runFn(expression)
      : runFacade(this.opts, expression);
  }

  async call<T>(key: string, expression: string, ttlMs: number): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value as T;

    const pending = this.inflight.get(key);
    if (pending) return (await pending) as T;

    const promise = this.run(expression)
      .then((value) => {
        this.entries.delete(key);
        this.entries.set(key, { at: this.now(), value });
        while (this.entries.size > MAX_FACADE_ENTRIES) {
          const oldest = this.entries.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.entries.delete(oldest);
        }
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return (await promise) as T;
  }

  /**
   * Cached value if there is a usable one, otherwise null -- and never a
   * wait on the CLI.
   *
   * Every `call` that misses pays for a ~139MB process spawn. On a route
   * the app loads at boot that is not a cache miss, it is a stall:
   * `/api/status` measured 6.5 SECONDS against the live service on
   * 2026-09-01 because it awaited exactly one such call, and the model pill
   * could not render until it returned.
   *
   * This is the stale-while-revalidate half of `call`. The caller gets an
   * answer immediately -- the last known value, or null so it can fall
   * back to a disk source -- and the refresh happens behind the response.
   * `staleMs` is deliberately separate from and larger than the caller's
   * freshness target: a value that is merely old is still far better than
   * a spinner, and the background refresh will have replaced it by the
   * next request.
   */
  peek<T>(
    key: string,
    expression: string,
    refreshAfterMs: number,
    staleMs = refreshAfterMs * 20,
  ): T | null {
    const hit = this.entries.get(key);
    const age = hit ? this.now() - hit.at : Infinity;
    if (age > refreshAfterMs && !this.inflight.has(key)) {
      // Rejections are swallowed on purpose: the desktop app may simply not
      // be running, which is a normal state for this server, not an error
      // worth failing a request over.
      void this.call<T>(key, expression, 0).catch(() => null);
    }
    if (!hit || age > staleMs) return null;
    return hit.value as T;
  }

  /** Fire-and-forget mutations must never be served from cache. */
  mutate(expression: string): Promise<unknown> {
    return this.run(expression);
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Drop every key under a prefix.
   *
   * The session list is cached per requested limit (`sessions:100`), so a
   * mutation that changes WHICH sessions exist cannot name the one key it
   * invalidated -- it has to clear the family.
   */
  invalidatePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

/** A session as the daemon knows it -- the shape `aside.sessions.list()` returns. */
export interface FacadeSession {
  id: string;
  title?: string;
  status?: 'running' | 'idle' | 'errored' | string;
  incognito?: boolean;
  ephemeral?: boolean;
  readAt?: string;
  createdAt?: string;
  updatedAt?: string;
  routineId?: string;
  trigger?: { type?: string; source?: string; title?: string };
}

export interface FacadeMessage {
  role: string;
  content: unknown;
  model?: string;
  provider?: string;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  details?: Record<string, unknown>;
  isError?: boolean;
  kind?: string;
}

export interface FacadeDefaultModel {
  provider: string;
  modelId: string;
  thinkingLevel: string;
  fastMode?: boolean;
}

/** JS literal for a string that is about to be interpolated into repl code. */
function lit(value: string): string {
  return JSON.stringify(value);
}

export function fetchSessions(
  cache: FacadeCache,
  limit = 100,
): Promise<FacadeSession[]> {
  return cache
    .call<FacadeSession[] | null>(
      `sessions:${limit}`,
      `aside.sessions.list({ limit: ${Number(limit) | 0} })`,
      4_000,
    )
    .then((rows) => (Array.isArray(rows) ? rows : []));
}

export function fetchSession(
  cache: FacadeCache,
  id: string,
): Promise<FacadeSession | null> {
  return cache.call<FacadeSession | null>(
    `session:${id}`,
    `aside.sessions.get(${lit(id)})`,
    4_000,
  );
}

/*
 * There is deliberately no `fetchMessages` here any more.
 *
 * `aside.sessions.messages(id)` returns the agent's current CONTEXT rather
 * than the conversation, which is why round 3 moved every read onto the
 * transcript on disk (see jsonl.ts). The wrapper survived that move with no
 * callers, which is exactly the sort of leftover that gets picked back up by
 * someone who assumes it is the supported path.
 */

export function fetchDefaultModel(
  cache: FacadeCache,
): Promise<FacadeDefaultModel | null> {
  return cache.call<FacadeDefaultModel | null>(
    DEFAULT_MODEL_KEY,
    DEFAULT_MODEL_EXPRESSION,
    30_000,
  );
}

const DEFAULT_MODEL_KEY = 'settings:defaultModel';
const DEFAULT_MODEL_EXPRESSION = 'aside.settings.getAll().defaultModel';

/**
 * The daemon's default model without blocking on it.
 *
 * `/api/status` is fetched during app boot, so it must not be the thing
 * that decides how long boot takes. The disk copy of the same value
 * (`settings.json`, which the desktop app itself writes) is the caller's
 * fallback and is never more than momentarily behind, so returning null
 * here costs correctness nothing.
 */
export function peekDefaultModel(
  cache: FacadeCache,
): FacadeDefaultModel | null {
  return cache.peek<FacadeDefaultModel | null>(
    DEFAULT_MODEL_KEY,
    DEFAULT_MODEL_EXPRESSION,
    30_000,
  );
}

/**
 * Clear a session's unread state, mirroring what opening it in the browser
 * sidepanel does. Best-effort: a failure here must never block a read.
 */
/**
 * Read-only routine metadata: name, schedule, next run, state. The facade
 * exposes `list`/`get` only -- create/update/delete require an `aside exec`
 * turn calling the `routine_update` tool, which costs a full turn. Day 4
 * plan (8.2) ships read plus pause/resume first and defers authoring.
 */
export function fetchRoutines(cache: FacadeCache): Promise<unknown[]> {
  return cache
    .call<unknown[] | null>('routines:list', 'aside.routines.list()', 10_000)
    .then((rows) => (Array.isArray(rows) ? rows : []));
}

/**
 * Remove a chat from the phone's history.
 *
 * `archive`, not a hard delete, and that is a deliberate choice rather than
 * a shortcut. The daemon exposes no destructive session verb at all: the
 * documented facade is `archive`/`unarchive`, and `sessions.list()` already
 * defaults to non-archived, so archiving is EXACTLY "gone from the list"
 * from the phone's point of view while staying recoverable on the desktop.
 *
 * The alternative -- deleting rows out of the daemon's private sqlite and
 * unlinking transcript files -- would orphan artifacts, race the running
 * daemon's own writes, and break on the next Aside release. A swipe on a
 * phone is not a good reason to reach into another process's database.
 *
 * Unlike `markSessionRead` this THROWS on failure. A read that silently
 * misses is a stale dot; a delete that silently misses is a row the user
 * watched disappear and then watched come back.
 */
export async function archiveSession(
  cache: FacadeCache,
  id: string,
): Promise<void> {
  await cache.mutate(`aside.sessions.archive(${lit(id)})`);
  cache.invalidate(`session:${id}`);
  // The list is cached under a per-limit key, so drop every one of them --
  // otherwise the row reappears on the next poll until the TTL lapses.
  cache.invalidatePrefix('sessions:');
}

export async function markSessionRead(
  cache: FacadeCache,
  id: string,
): Promise<boolean> {
  try {
    await cache.mutate(`aside.sessions.markRead(${lit(id)})`);
    cache.invalidate(`session:${id}`);
    return true;
  } catch {
    return false;
  }
}
