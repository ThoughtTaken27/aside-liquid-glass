/**
 * Running as an installed app instead of inside Telegram.
 *
 * Telegram gives the mini app three things for free: a signed identity on
 * every launch, a stable entry point (the bot's menu button, which the server
 * re-registers whenever the tunnel hostname rotates), and a place to live.
 * Installed to the home screen all three go away, and this module covers the
 * first one.
 *
 * The trade is deliberate. Telegram's initData is re-signed on every single
 * launch; a paired token is minted once and then sits in localStorage for
 * three months. That is only reasonable because the server is reachable over
 * a private tailnet rather than the open internet, so the token is a second
 * lock on a door that is already inside the house.
 */
import { api, setAuthToken } from './api';

const TOKEN_KEY = 'aside.standalone.token';

/** True when launched from the home screen rather than a browser tab. */
export function isInstalled(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari predates the display-mode media query for this.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** True when this build was served from the standalone entry point. */
export function isStandaloneEntry(): boolean {
  return location.pathname === '/app' || location.pathname.startsWith('/app/');
}

export function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private-mode localStorage throws rather than returning null.
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Non-fatal: the session still works, it just will not survive a restart.
  }
}

const NAME_KEY = 'aside.standalone.name';

export function storeName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* greeting falls back to the nameless form */
  }
}

export function readStoredName(): string | undefined {
  try {
    return localStorage.getItem(NAME_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * Pull a one-time pairing key out of the launch URL.
 *
 * Accepted in the hash (`#pair=...`) so it is never sent to the server as
 * part of the request line, and therefore never lands in an access log.
 */
export function readPairingKey(): string | null {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('pair');
  if (fromHash) return fromHash;
  return new URLSearchParams(location.search).get('pair');
}

/** Strip the pairing key from the address bar once it has been spent. */
export function scrubPairingKey(): void {
  if (!readPairingKey()) return;
  const url = new URL(location.href);
  url.hash = '';
  url.searchParams.delete('pair');
  history.replaceState(null, '', url.pathname + url.search);
}

/**
 * Ask the browser not to evict this origin's storage.
 *
 * Android Chrome treats storage for an ordinary site as discardable and
 * will clear it under pressure, which is one of the ways the paired token
 * used to vanish. An installed app that the user engages with is normally
 * granted this without a prompt. Best-effort: the session cookie is the
 * real durability guarantee, this just stops the cheap loss.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * Seconds left on a JWT, read without verifying it.
 *
 * Only used to decide whether to bother trying a stored token before
 * falling back to cookie recovery. The server verifies for real.
 */
function secondsLeft(token: string): number {
  try {
    const [, payload] = token.split('.');
    if (!payload) return 0;
    const json = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: number };
    if (typeof json.exp !== 'number') return 0;
    return Math.max(0, json.exp - Math.floor(Date.now() / 1000));
  } catch {
    return 0;
  }
}

export type StandaloneAuth =
  | { ok: true; token: string; paired: boolean; name?: string }
  | { ok: false; reason: 'needs_pairing' | 'pair_rejected' | 'unreachable' };

/**
 * Resolve a usable bearer token for a standalone launch.
 *
 * Order matters: a pairing key in the URL wins over a stored token, so
 * re-pairing is always possible by opening a fresh pairing link, even when
 * the stored token has gone bad.
 */
export async function resolveStandaloneAuth(): Promise<StandaloneAuth> {
  void requestPersistentStorage();

  const key = readPairingKey();
  if (key) {
    try {
      const res = await api.pair(key);
      storeToken(res.token);
      if (res.name) storeName(res.name);
      scrubPairingKey();
      return { ok: true, token: res.token, paired: true, name: res.name };
    } catch (err) {
      scrubPairingKey();
      const status = (err as { status?: number }).status;
      // A 401 is a wrong key. Anything else means the Mac did not answer,
      // which is a different problem with a different fix, so it gets a
      // different message rather than "pairing failed".
      return { ok: false, reason: status === 401 ? 'pair_rejected' : 'unreachable' };
    }
  }

  // A stored token that still has real life left is the fast path: no
  // request, no spinner. One minute of slack avoids handing the app a token
  // that expires between this check and the next call.
  const stored = readStoredToken();
  if (stored && secondsLeft(stored) > 60) {
    // Refreshed in the background so a token that is merely old, rather
    // than expired, still gets renewed without delaying the launch.
    void recoverSession().catch(() => undefined);
    return { ok: true, token: stored, paired: false, name: readStoredName() };
  }

  /*
   * Nothing usable in storage. Before declaring this unpaired, ask the
   * server whether the browser still holds the session cookie. This is the
   * path that fixes the "pair every single time" problem: localStorage can
   * be evicted, written by a different browser, or never have existed on
   * this profile, and none of that touches the cookie.
   */
  try {
    const res = await recoverSession();
    return { ok: true, token: res.token, paired: false, name: res.name };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) {
      // Genuinely not paired, or the session finally aged out.
      return { ok: false, reason: 'needs_pairing' };
    }
    // The Mac did not answer at all. Saying "not paired" here would send the
    // owner to generate a pairing link on a machine that is asleep.
    if (stored) return { ok: true, token: stored, paired: false, name: readStoredName() };
    return { ok: false, reason: 'unreachable' };
  }
}

/** Trade the session cookie for a fresh token and persist it locally. */
async function recoverSession(): Promise<{ token: string; name?: string }> {
  const res = await api.session();
  storeToken(res.token);
  if (res.name) storeName(res.name);
  return { token: res.token, name: res.name };
}

/**
 * Register the service worker, and let a running app find a new build.
 *
 * Only from the standalone entry: inside Telegram the worker would buy
 * nothing (Telegram's webview is not installable) while adding a cache layer
 * that can serve a stale bundle after a rebuild.
 *
 * Registration alone was not enough, and the failure is easy to miss from
 * the Mac. An installed phone app is rarely NAVIGATED; it is backgrounded
 * and foregrounded for days. Nothing in that cycle re-fetches `/sw.js`, so
 * a rebuilt bundle sat on the server while the phone kept painting the
 * frame it had loaded hours earlier -- which reads exactly like "the fix
 * did not ship" even when the server is serving the new bytes.
 *
 * Two narrow additions close it:
 *
 *   - ask for an update when the app comes back to the foreground, which is
 *     the only reliable "the user is here again" signal a PWA gets, rate
 *     limited so a fast app-switch does not hammer the Mac;
 *   - reload once when a NEW worker takes control, because at that moment
 *     the old caches are already deleted and the page is holding markup and
 *     CSS from a build that no longer exists on the server.
 *
 * The reload is guarded on there having been a previous controller. On a
 * first install `controllerchange` fires too, and reloading there would
 * bounce the app on the very first launch for no reason.
 */
const SW_UPDATE_MIN_INTERVAL_MS = 30_000;

export function registerServiceWorker(): void {
  if (!isStandaloneEntry()) return;
  if (!('serviceWorker' in navigator)) return;

  // Read before any new worker can claim the page: `controller` is null on a
  // first install and set on every launch after it.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        let last = 0;
        const check = () => {
          if (document.visibilityState !== 'visible') return;
          const now = Date.now();
          if (now - last < SW_UPDATE_MIN_INTERVAL_MS) return;
          last = now;
          // Offline is the normal case here, not an error: the Mac is
          // asleep and the app keeps running on what it has.
          registration.update().catch(() => {});
        };
        document.addEventListener('visibilitychange', check);
        // A normal foreground reload can otherwise keep displaying the
        // previously controlled shell while the new worker is waiting. The
        // update check above only runs on load/foreground transitions; ask
        // again as soon as the worker is ready, too.
        navigator.serviceWorker.ready.then(() => registration.update().catch(() => {}), () => {});
        check();
      })
      .catch(() => {
        // Installability is a nice-to-have. The app works without it.
      });
  });
}

export { setAuthToken };
