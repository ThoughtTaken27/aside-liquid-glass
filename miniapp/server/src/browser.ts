/**
 * Remote browser control, through the exact same facade every other read
 * in this server already uses (`aside repl`, via `facade.ts`). Section 7
 * of the build plan: a tab deck, page peek, and watch mode -- the one
 * capability nobody else in the category has (a real screenshot of the
 * real page on the real machine, not a diff).
 *
 * `aside repl "<js>"` spawns a fresh ~139MB binary PER CALL (see
 * `facade.ts`'s own docs) rather than holding a persistent REPL scope
 * across calls. That is what makes the "orphaned attached tab" risk in the
 * plan's risk register mostly moot here: `attachBrowserTab` only lives for
 * the lifetime of the one process that called it, and that process exits
 * the moment the script returns. There is no cross-call state to leak.
 * What IS a real risk, and what this module guards against directly, is
 * spawning too many of those 139MB processes too fast -- the plan's
 * "screenshot spam thrashes the M1 Air" risk. See `CaptureGate` below.
 */
import { FacadeCache } from './facade.js';

export class BrowserError extends Error {
  constructor(
    readonly code:
      | 'bad_url'
      | 'not_found'
      | 'rate_limited'
      | 'capture_busy'
      | 'upstream',
    message?: string,
  ) {
    super(message || code);
    this.name = 'BrowserError';
  }
}

export interface BrowserTab {
  id: string;
  targetId: string;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  faviconUrl?: string;
}

/** JS literal for a string interpolated into a repl expression. */
function lit(value: string): string {
  return JSON.stringify(value);
}

function isBrowserTab(value: unknown): value is BrowserTab {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as BrowserTab).targetId === 'string'
  );
}

/** Tab list. Cheap and read-only, so it goes through the normal TTL cache. */
export async function listTabs(cache: FacadeCache): Promise<BrowserTab[]> {
  const rows = await cache.call<unknown>(
    'browser:tabs',
    'listBrowserTabs()',
    2_000,
  );
  return Array.isArray(rows) ? rows.filter(isBrowserTab) : [];
}

/**
 * Open a URL in a new tab and hand back its targetId.
 *
 * `openTab` itself does not return a targetId (Playwright pages don't
 * carry one), so this re-lists tabs from WITHIN the same script -- one
 * process, one moment in time -- and matches on exact URL. A redirect
 * that lands somewhere else by the time `listBrowserTabs` runs would miss
 * that match; the fallback is whichever tab is now `active`, since opening
 * a tab focuses it. Best-effort, and documented as such in the return
 * type: `targetId` can be `null` on a redirect this heuristic could not
 * follow, in which case the caller should fall back to `listTabs`.
 */
export async function openNewTab(
  cache: FacadeCache,
  rawUrl: string,
): Promise<{ targetId: string | null; url: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BrowserError('bad_url', 'not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserError('bad_url', 'only http/https URLs may be opened');
  }

  const script = `(async () => {
    const p = await openTab(${lit(parsed.toString())});
    const finalUrl = p.url();
    const rows = await listBrowserTabs();
    const exact = rows.find((t) => t.url === finalUrl);
    const active = rows.find((t) => t.active);
    const match = exact || active || null;
    return { targetId: match ? match.targetId : null, url: finalUrl };
  })()`;

  const result = await cache.mutate(script);
  // The tab list is cached for 2s. Without dropping it here, the very next
  // poll re-serves a snapshot taken BEFORE this tab existed, so a tab the
  // user just opened appears to not have opened for up to two seconds.
  cache.invalidate('browser:tabs');
  const record = (result || {}) as { targetId?: string | null; url?: string };
  return { targetId: record.targetId ?? null, url: record.url || parsed.toString() };
}

/** Close a tab by targetId. Returns false rather than throwing when it is already gone -- a stale Tab Deck entry closing itself is not an error. */
export async function closeTab(
  cache: FacadeCache,
  targetId: string,
): Promise<boolean> {
  const script = `(async () => {
    const rows = await listBrowserTabs();
    const target = rows.find((t) => t.targetId === ${lit(targetId)});
    if (!target) return { closed: false };
    const p = await attachBrowserTab(${lit(targetId)});
    await closeTab(p);
    return { closed: true };
  })()`;
  const result = await cache.mutate(script);
  // Same reason as `openNewTab`, and worse here: the stale read would
  // RESURRECT a tab the user watched disappear, which reads as the close
  // having failed.
  cache.invalidate('browser:tabs');
  return Boolean((result as { closed?: boolean } | null)?.closed);
}

export interface PageSnapshot {
  tree: string;
  capturedAt: number;
}

/**
 * A structured accessibility-tree read of a tab -- cheaper than a
 * screenshot and useful for "what does this page actually say" rather
 * than "what does it look like". Short TTL cache: unlike a screenshot,
 * re-reading a snapshot a few times in a row for the same tab is cheap
 * enough to memoize, and a page mid-navigation benefits from not
 * re-spawning a process for every rapid poll.
 */
export async function snapshotTab(
  cache: FacadeCache,
  targetId: string,
): Promise<PageSnapshot> {
  const script = `(async () => {
    const rows = await listBrowserTabs();
    if (!rows.find((t) => t.targetId === ${lit(targetId)})) return null;
    const p = await attachBrowserTab(${lit(targetId)});
    const s = await snapshot(p, { interactive: true });
    return { tree: s.tree };
  })()`;
  const result = await cache.call<{ tree: string } | null>(
    `browser:snapshot:${targetId}`,
    script,
    5_000,
  );
  if (!result) throw new BrowserError('not_found', 'tab not found');
  return { tree: result.tree, capturedAt: Date.now() };
}

export interface CaptureResult {
  /** Raw base64 WebP bytes -- callers decide whether to wrap as a data URL or serve as `image/webp` directly. */
  base64: string;
  url: string;
  capturedAt: number;
}

const MIN_QUALITY = 10;
const MAX_QUALITY = 100;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * A live screenshot of a tab. NEVER cached -- a stale screenshot presented
 * as live is a correctness bug the plan calls out explicitly (7.3). Rate
 * limiting is the caller's job via `CaptureGate`, not this function's: it
 * always does exactly one facade call when invoked.
 *
 * Deliberately does not touch viewport size. This is the owner's REAL,
 * already-open browser window on their REAL machine -- resizing it on
 * every phone-initiated capture would be visibly disruptive on the desktop
 * they are sitting in front of.
 *
 * There is therefore NO width parameter, and the route does not accept one.
 * An earlier draft exported MIN_WIDTH/MAX_WIDTH for a `?w=` the route never
 * read; that was dead code and is gone. Downscaling would need a resampler
 * (`sharp` is not a dependency here and is not worth adding for this), so
 * the size lever that actually exists is `quality`. The client scales with
 * CSS at render time.
 */
export async function captureTab(
  cache: FacadeCache,
  targetId: string,
  opts: { quality?: number } = {},
): Promise<CaptureResult> {
  const quality = clamp(opts.quality ?? 55, MIN_QUALITY, MAX_QUALITY);
  const script = `(async () => {
    const rows = await listBrowserTabs();
    if (!rows.find((t) => t.targetId === ${lit(targetId)})) return null;
    const p = await attachBrowserTab(${lit(targetId)});
    const buf = await p.screenshot({ type: 'webp', quality: ${quality} });
    return { base64: buf.toString('base64'), url: p.url() };
  })()`;
  const result = await cache.mutate(script);
  const record = result as { base64?: string; url?: string } | null;
  if (!record?.base64) throw new BrowserError('not_found', 'tab not found');
  return { base64: record.base64, url: record.url || '', capturedAt: Date.now() };
}

/** Floor between two captures of the same tab. */
export const CAPTURE_TAB_FLOOR_MS = 2_000;
/** Rolling window for the global ceiling. */
export const CAPTURE_WINDOW_MS = 60_000;
/** Captures allowed per rolling window, across ALL tabs. */
export const CAPTURE_WINDOW_MAX = 40;

/**
 * Enforces capture discipline: one concurrent capture GLOBALLY (every
 * capture spawns a 139MB process; two at once is exactly the thrash risk),
 * a 2s floor between captures of the SAME tab, and a rolling global
 * ceiling.
 *
 * The rolling ceiling is the fix for a gap the first cut of this file left
 * open. The per-turn ceiling (100 captures) lived only in WatchMode.tsx,
 * i.e. entirely client side, so nothing on the server bounded a client that
 * was buggy, backgrounded, or simply left open. The per-tab floor does not
 * close that: it is per TAB, so a client cycling several tabs slips past it,
 * and concurrency-1 only serialises the work rather than limiting it. At
 * ~670ms per capture that allowed a sustained ~89 processes/minute against
 * an 8GB machine.
 *
 * 40 per 60s is deliberately generous against real use: Watch Mode's fastest
 * cadence is 3s (20/min) and it backs off to 6s and 10s, leaving headroom for
 * manual peeks on top. A runaway client is bounded to 40/min instead of ~89.
 *
 * All three limits are checked BEFORE the work starts, and the per-tab
 * timestamp is recorded in `finally` rather than on success. Recording only
 * on success meant a tab whose captures kept failing had no floor at all and
 * could be retried as fast as the client asked, which is the exact condition
 * under which retry storms happen.
 */
export class CaptureGate {
  private lastByTab = new Map<string, number>();
  private recent: number[] = [];
  private inFlight = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** Drop timestamps that have aged out of the rolling window. */
  private prune(at: number): void {
    const cutoff = at - CAPTURE_WINDOW_MS;
    while (this.recent.length && this.recent[0] <= cutoff) this.recent.shift();
  }

  async run<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
    const at = this.now();
    const last = this.lastByTab.get(targetId) ?? 0;
    if (at - last < CAPTURE_TAB_FLOOR_MS) {
      throw new BrowserError('rate_limited', 'capture this tab again in a moment');
    }
    this.prune(at);
    if (this.recent.length >= CAPTURE_WINDOW_MAX) {
      throw new BrowserError(
        'rate_limited',
        'too many captures in the last minute; pausing to keep the Mac responsive',
      );
    }
    if (this.inFlight) {
      throw new BrowserError('capture_busy', 'another capture is already running');
    }

    this.inFlight = true;
    this.recent.push(at);
    try {
      return await fn();
    } finally {
      // Both in `finally`: a failed capture must still hold the floor, or a
      // erroring tab can be hammered with no throttle at all.
      this.lastByTab.set(targetId, this.now());
      this.inFlight = false;
    }
  }
}
