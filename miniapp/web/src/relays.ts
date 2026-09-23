/**
 * Client-side relay failover for the installed app.
 *
 * The server publishes the app port on up to two stable public origins
 * (Funnel first, ngrok behind it) and tells every standalone page about
 * them twice: as an `aside-relays` meta tag baked into the shell, and as
 * the authenticated `/api/relays` route for refreshes after boot. This
 * module turns that list into behaviour:
 *
 *  - any failed request asks whether the current origin is actually dead,
 *    and if so navigates to the first relay that answers a health probe;
 *  - the boot path does the same awaited, so a dead primary at launch
 *    moves to the backup instead of showing "can't reach your Mac";
 *  - a page living on the backup can poll the primary and offer the way
 *    back once it answers again.
 *
 * Three properties keep this from ever making things worse. Navigation
 * only ever goes TO an origin that just answered a probe, never away on a
 * guess. An install with no relays configured (or a Telegram launch, whose
 * shell carries no meta tag) has an empty candidate list and every entry
 * point below is a no-op. And each origin keeps its own stored token, so
 * landing on a backup that was never paired shows the normal pairing
 * screen -- the pairing page says as much -- rather than failing silently.
 *
 * This module imports nothing from the app: `api.ts` calls into it on
 * every network failure, and `api.ts` is imported by everything, so any
 * import back out of here would be a cycle.
 */

/** Same shape the server enforces: `https://host` with an optional port. */
export function isPublicOrigin(value: string): boolean {
  return /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/.test(
    value.trim(),
  );
}

/** The failover list the server baked into this page's shell. */
export function readInjectedRelays(): string[] {
  try {
    const tag = document.querySelector('meta[name="aside-relays"]');
    const content = tag?.getAttribute('content') || '';
    return content.split(/\s+/).filter(isPublicOrigin);
  } catch {
    return [];
  }
}

/**
 * Fresher list from `/api/relays`, set once per boot after auth succeeds.
 * Relays verify asynchronously after the server starts, so the meta tag can
 * lag behind reality on the first load.
 */
let refreshedRelays: string[] = [];

export function setRefreshedRelays(urls: string[]): void {
  refreshedRelays = urls.filter(isPublicOrigin);
}

/** Ordered failover candidates: injected first, then refreshed, minus here. */
export function failoverCandidates(): string[] {
  const seen = new Set<string>([location.origin]);
  const out: string[] = [];
  for (const url of [...readInjectedRelays(), ...refreshedRelays]) {
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/** The primary relay: first injected origin, or null when unconfigured. */
export function primaryRelay(): string | null {
  return readInjectedRelays()[0] ?? null;
}

/** True when this page is living on a backup rather than the primary. */
export function isOnBackup(): boolean {
  const primary = primaryRelay();
  return primary !== null && primary !== location.origin;
}

/**
 * True when the origin answers `/api/health` within the timeout.
 *
 * Same-origin probes read the response normally. Cross-origin probes use
 * `no-cors`, which resolves opaquely for ANY http answer -- the server
 * sends no CORS headers, so reading the body is impossible and reaching
 * the question is the whole test. A network failure, a TLS failure, or a
 * timeout rejects, which is exactly the "this address is dead" signal the
 * caller wants.
 */
export async function probeOrigin(origin: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (origin === location.origin) {
      const res = await fetch(`${origin}/api/health`, {
        cache: 'no-store',
        signal: ctrl.signal,
      });
      return res.ok;
    }
    await fetch(`${origin}/api/health`, {
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** First candidate that answers, in failover order. */
export async function findHealthyRelay(timeoutMs: number): Promise<string | null> {
  for (const candidate of failoverCandidates()) {
    if (await probeOrigin(candidate, timeoutMs)) return candidate;
  }
  return null;
}

/**
 * Where a failover navigation lands: the same path, query and hash on the
 * new origin. The hash matters -- a pairing key in `#pair=` must survive
 * the hop, or a failover during pairing eats the credential it was
 * carrying.
 */
export function relayDestinationUrl(origin: string): string {
  return `${origin}${location.pathname}${location.search}${location.hash}`;
}

/** Navigate to a relay, unless it is the origin we are already on. */
export function navigateToRelay(origin: string): void {
  let target: string;
  try {
    target = new URL(origin).origin;
  } catch {
    return;
  }
  if (target === location.origin) return;
  location.assign(relayDestinationUrl(origin));
}

/** Only the standalone entry fails over; Telegram has its own host. */
function isStandaloneEntryPath(): boolean {
  return location.pathname === '/app' || location.pathname.startsWith('/app/');
}

let failoverCompleted = false;
let failoverInflight: Promise<string | null> | null = null;

/**
 * Move to the first healthy relay, if the current origin is dead and one
 * answers. Single-flight: concurrent failures share one round of probes,
 * and a page that already failed over once never navigates itself again --
 * the destination boot runs its own check with its own fresh list.
 *
 * Resolves true when a navigation was started. The page unloads, so callers
 * should treat true as "do not bother rendering the error state".
 */
export function failoverToHealthyRelay(): Promise<boolean> {
  if (failoverCompleted || !isStandaloneEntryPath()) {
    return Promise.resolve(false);
  }
  if (!failoverCandidates().length) return Promise.resolve(false);
  failoverInflight ??= (async (): Promise<string | null> => {
    try {
      // The current origin gets the first word: most isolated failures are
      // a blip, a sleeping Mac, or airplane wifi, and navigating away on
      // those would strand the app on a backup for no reason.
      if (await probeOrigin(location.origin, 5000)) return null;
      const healthy = await findHealthyRelay(4000);
      if (healthy) {
        failoverCompleted = true;
        navigateToRelay(healthy);
        return healthy;
      }
      return null;
    } catch {
      return null;
    } finally {
      failoverInflight = null;
    }
  })();
  return failoverInflight.then((url) => url !== null);
}

/** Fire-and-forget form for the api client's failure path. */
export function considerFailover(): void {
  void failoverToHealthyRelay().catch(() => undefined);
}

/**
 * True when the primary answers again while this page lives on a backup.
 * The app polls this on an interval and offers the way back; it never
 * navigates on its own, because dropping the owner mid-thread the moment
 * the primary flickers would be worse than staying put.
 */
export async function isPrimaryBack(): Promise<boolean> {
  const primary = primaryRelay();
  if (!primary || primary === location.origin) return false;
  return probeOrigin(primary, 5000);
}
