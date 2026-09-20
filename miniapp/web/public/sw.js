/**
 * Service worker: installability, and nothing clever.
 *
 * A service worker is the one piece of this app that can break it in a way
 * a reload does not fix, because a bad cache entry outlives the page that
 * created it. So the rules here are deliberately narrow.
 *
 *   /assets/*  content-hashed by Vite, so a given URL's bytes never change.
 *              Safe to serve from cache first and keep forever.
 *   /icons/*   same idea, changes only when the file name does.
 *   /art/*     versioned artwork, cached after its first fetch.
 *   /api, /ws  never touched. A cached API response is a wrong answer, and a
 *              stale session list is worse than a spinner.
 *   navigation network-first, cache as fallback, so a new build is picked up
 *              the moment the Mac is reachable and the shell still opens when
 *              it is not.
 *
 * The version string is the whole cache-busting story: bump it and every old
 * cache is dropped on activate.
 */
/*
 * v2: the search rewrite. v1 shipped a stylesheet with an unclosed rule
 * that silently voided every rule after it, and because `/assets/*` is
 * cache-first and never revalidated, a phone that fetched it once kept
 * rendering the broken build even after the server was fixed. Content
 * hashing does not save you here: it only helps if the HTML referencing
 * the new hash is itself fresh, and the shell falls back to cache the
 * moment the Mac is briefly unreachable. Deleting every non-matching
 * cache on activate is the only reliable way out of that state.
 */
/*
 * Stamped at build time by the `sw-build-id` plugin in vite.config.ts, from
 * a hash of the emitted asset filenames. It was a hand-written string with
 * a comment telling the next person to remember to bump it, which is the
 * kind of instruction that gets forgotten exactly once and then costs a
 * phone that renders unstyled until someone reinstalls the app.
 *
 * The failure it prevents, reproduced before this changed: a cached shell
 * outlives the assets it points at. `npm run build` empties dist and emits
 * new content hashes, so the old `/assets/index-<hash>.css` is gone from
 * the server. The shell in the cache still asks for it, the asset handler
 * misses, the fetch 404s, and the app paints with no stylesheet. Nothing
 * recovers from that on its own, because both caches are behaving exactly
 * as designed.
 *
 * Tying the version to the build means every deploy invalidates the shell,
 * so the shell and the assets can never disagree about which build it is.
 */
const VERSION = 'aside-__BUILD_ID__';

/**
 * How long a cold start waits for the Mac before painting from cache.
 *
 * Straight network-first made every launch block on a round trip to the
 * Mac over the tailnet for the shell, and only then start fetching ~575 KB
 * of hashed assets. When the Mac is awake and nearby that is a couple of
 * hundred milliseconds; when it is waking, on another network, or the
 * tunnel is reconnecting, it is seconds of white screen.
 *
 * Straight cache-first fixes the stall and introduces a worse problem: a
 * shell cached from an older build points at older asset hashes, which are
 * themselves cached, so a new build would not appear until the second
 * launch. During active development that reads as "my change did not ship".
 *
 * Racing the two removes both failure modes. The network wins whenever it
 * is merely normal-slow, so the freshest build is what renders; the cache
 * only steps in when waiting would have been visible anyway, and the
 * network response still lands in the cache for next time.
 */
const SHELL_TIMEOUT_MS = 350;
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

const SHELL_URL = '/app';
const ART_URL = '/art/zeron-liquid-dots-v2.webp';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Best-effort: a failed precache must not block installation, or the
      // app becomes uninstallable whenever the Mac happens to be asleep.
      await Promise.allSettled([
        cache.add(SHELL_URL),
        cache.add(ART_URL),
      ]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isImmutable(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/art/')
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  if (isImmutable(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const res = await fetch(request);
        if (res.ok) {
          const cache = await caches.open(ASSETS);
          cache.put(request, res.clone());
        }
        return res;
      })(),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        // Kicked off first so the clock starts before anything is awaited.
        const network = fetch(request)
          .then(async (res) => {
            if (res.ok) {
              const cache = await caches.open(SHELL);
              await cache.put(SHELL_URL, res.clone());
            }
            return res;
          })
          .catch(() => null);

        const cached = await caches.match(SHELL_URL);
        if (cached) {
          const winner = await Promise.race([
            network,
            new Promise((resolve) => setTimeout(() => resolve(null), SHELL_TIMEOUT_MS)),
          ]);
          if (winner) return winner;
          // Serve what we have, but let the fetch finish so the cache is
          // current for the next launch rather than permanently stale.
          event.waitUntil(network);
          return cached;
        }

        try {
          const res = await network;
          if (res) return res;
          throw new Error('offline');
        } catch {
          // Offline with nothing cached. An honest page beats the browser's
          // dinosaur, because the fix here is "wake the Mac", not "get signal".
          return new Response(
            `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
             <style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#f9f9f7;color:#2d2d2b;
             display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;text-align:center}
             div{max-width:22rem;padding:2rem}p{opacity:.7}</style>
             <div><h1>Can't reach your Mac</h1>
             <p>Aside runs on your MacBook, so it needs to be awake and on the network.
             Check that Amphetamine is on if the lid is shut.</p></div>`,
            { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 503 },
          );
        }
      })(),
    );
  }
});
