/**
 * Public relay registry: the $0 path from the phone to the Mac.
 *
 * The phone used to reach this server over the tailnet, which meant the
 * Tailscale app had to be installed, signed in and holding the iOS VPN slot
 * on the phone. That slot is the whole problem: only one VPN app can own it,
 * so the owner's real VPN and the bridge fought over it, and whoever lost
 * left the phone disconnected.
 *
 * These relays flip the arrangement around. The Mac publishes its loopback
 * app port to the public internet over plain HTTPS, and the phone becomes an
 * ordinary browser client with no VPN or mesh software at all:
 *
 *  - `funnel` (primary): `tailscale funnel` serves the app port on the
 *    Mac's existing MagicDNS name at port 443. Same Tailscale the Mac
 *    already runs, no new account, no new daemon, URL never rotates.
 *  - `ngrok` (backup): `ngrok http` with a free static
 *    `<name>.ngrok-free.dev` domain. Needs a free ngrok account and its
 *    authtoken; stands in automatically when Funnel is down.
 *
 * Both are opportunistic and supervised. Each relay either verifies it is
 * actually serving -- by reading back the proxy's own status -- or reports
 * no URL, in which case everything downstream (menu button, pairing page,
 * client failover) silently falls back to whatever is left, exactly as if
 * the relay had never been enabled. Enabling a relay can therefore never
 * break a working setup; the worst case is today's behaviour plus a log
 * line saying why the relay is unavailable.
 *
 * The URLs are static by construction, which is what makes them worth
 * having: a home-screen icon bakes its URL at install time and has no way
 * to learn a new one, so only a URL that never rotates can be paired once
 * and trusted afterwards. That property also keeps the failure mode boring:
 * a relay going down changes reachability, never identity, so the client
 * fails over by navigating to the next URL in the ordered list rather than
 * by re-pairing or re-provisioning anything.
 */

export type RelayKind = 'funnel' | 'ngrok';

/** Failover order. Funnel first: no extra account, no interstitial page. */
export const RELAY_ORDER: readonly RelayKind[] = ['funnel', 'ngrok'];

/**
 * What one relay looks like to the outside world.
 *
 * `url` is null until the relay has VERIFIED it is serving -- see the module
 * comment -- so a null here means "do not send the phone anywhere yet", not
 * "broken". `healthy` is the last known state once a URL exists; null means
 * no check has completed. `detail` is a human sentence for the log and the
 * settings screen, never a secret.
 */
export interface RelayInfo {
  kind: RelayKind;
  url: string | null;
  healthy: boolean | null;
  detail: string | null;
}

export interface RelayHandle {
  readonly kind: RelayKind;
  snapshot(): RelayInfo;
  stop(): Promise<void>;
}

/**
 * Accept exactly one shape: `https://host` with an optional `:port`.
 *
 * This guards two sinks at once: the `connect-src` directive the server
 * emits (a value that is not an exact origin would either break the header
 * or, worse, smuggle in a wildcard) and the client's failover list (which
 * must never navigate the owner to a `javascript:` URL no matter what a
 * config file claims). Anything else is dropped, not fixed up.
 */
export function isPublicOrigin(value: string): boolean {
  return /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/.test(
    value.trim(),
  );
}

/** Normalize a configured hostname into the `https://host` origin form. */
export function toPublicOrigin(hostname: string): string | null {
  const bare = hostname
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!bare) return null;
  const origin = `https://${bare}`;
  return isPublicOrigin(origin) ? origin : null;
}

export interface OrderedRelay {
  kind: RelayKind;
  url: string;
}

export interface RelayRegistry {
  register(handle: RelayHandle): void;
  handles(): readonly RelayHandle[];
  /**
   * Public URLs in failover order, skipping relays that have not verified
   * a URL yet. This is the list the pairing page prints and the client
   * navigates.
   */
  orderedUrls(): OrderedRelay[];
  primary(): OrderedRelay | null;
  snapshot(): RelayInfo[];
  /**
   * Wait for any relay to verify a URL, so the menu button can be pointed
   * at the stable address at boot instead of at a rotating quick-tunnel
   * URL. Resolves null on timeout -- the caller falls back to whatever it
   * has, exactly as if relays were disabled.
   */
  waitForUrl(timeoutMs: number): Promise<OrderedRelay | null>;
  stopAll(): Promise<void>;
}

export function createRelayRegistry(): RelayRegistry {
  const handles: RelayHandle[] = [];
  const byKind = (kind: RelayKind): RelayHandle | undefined =>
    handles.find((handle) => handle.kind === kind);

  return {
    register(handle: RelayHandle): void {
      const existing = handles.findIndex((h) => h.kind === handle.kind);
      if (existing >= 0) handles.splice(existing, 1);
      handles.push(handle);
    },

    handles(): readonly RelayHandle[] {
      return [...handles];
    },

    orderedUrls(): OrderedRelay[] {
      const out: OrderedRelay[] = [];
      for (const kind of RELAY_ORDER) {
        const snap = byKind(kind)?.snapshot();
        if (snap?.url && isPublicOrigin(snap.url)) {
          out.push({ kind, url: snap.url });
        }
      }
      return out;
    },

    primary(): OrderedRelay | null {
      return this.orderedUrls()[0] ?? null;
    },

    snapshot(): RelayInfo[] {
      return RELAY_ORDER.map(
        (kind) =>
          byKind(kind)?.snapshot() ?? {
            kind,
            url: null,
            healthy: null,
            detail: 'disabled',
          },
      );
    },

    waitForUrl(timeoutMs: number): Promise<OrderedRelay | null> {
      const found = this.primary();
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          const current = this.primary();
          if (current || Date.now() - startedAt >= timeoutMs) {
            clearInterval(timer);
            resolve(current);
          }
        }, 250);
        if (typeof timer.unref === 'function') timer.unref();
      });
    },

    async stopAll(): Promise<void> {
      for (const handle of handles) {
        try {
          await handle.stop();
        } catch {
          // Shutdown must not fail because a relay already died.
        }
      }
    },
  };
}
