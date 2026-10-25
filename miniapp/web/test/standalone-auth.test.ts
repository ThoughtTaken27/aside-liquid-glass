/**
 * Standalone boot auth: a pairing key wins over storage, failures name
 * their kind, and the phone being offline never waits through failover.
 *
 * The case this exists for: a Funnel relay that is down while the Mac is
 * up. The fetch dies with no HTTP status, which used to render as
 * \"check it's awake and on the same tailnet\" -- the wrong fix for a
 * Funnel link. Now the message names the relay and points at the tailnet
 * link, and a phone with no network at all says so instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PHONE_OFFLINE_MESSAGE,
  classifyPairFailure,
  pairUnreachableMessage,
  phoneIsOffline,
  resolveStandaloneAuth,
} from '../src/standalone';

const CODE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function tokenWithExpiry(secondsFromNow: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.sig`;
}

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => handler(String(input))),
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value: online,
    configurable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
  setOnline(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = '';
  setOnline(true);
});

describe('classifyPairFailure', () => {
  it('reads 401 as a rejected link whatever the radio says', () => {
    expect(classifyPairFailure(401, false)).toBe('rejected');
    expect(classifyPairFailure(401, true)).toBe('rejected');
  });

  it('reads a dead fetch on an offline phone as offline', () => {
    expect(classifyPairFailure(undefined, true)).toBe('offline');
  });

  it('reads a dead fetch on an online phone as unreachable', () => {
    expect(classifyPairFailure(undefined, false)).toBe('unreachable');
  });

  it('treats other HTTP errors as unreachable, not rejected', () => {
    expect(classifyPairFailure(500, false)).toBe('unreachable');
  });
});

describe('pairing failure copy', () => {
  it('tells an offline phone to reconnect', () => {
    expect(PHONE_OFFLINE_MESSAGE).toMatch(/No internet on this phone/);
  });

  it('names the relay and the tailnet recovery for a dead address', () => {
    const message = pairUnreachableMessage();
    expect(message).toMatch(/public relay is likely down/);
    expect(message).toMatch(/pairing page on the Mac/);
    expect(message).toMatch(/Tailnet link/);
    expect(message).not.toMatch(/same tailnet/);
  });

  it('knows when the phone is offline', () => {
    expect(phoneIsOffline()).toBe(false);
    setOnline(false);
    expect(phoneIsOffline()).toBe(true);
  });
});

describe('resolveStandaloneAuth with a pairing key', () => {
  it('spends the key, stores the token, and scrubs the URL', async () => {
    window.location.hash = `#pair=${CODE}`;
    stubFetch((url) =>
      url.endsWith('/api/pair')
        ? json(200, { token: 'fresh-token', name: 'Owner', expiresIn: 7776000 })
        : json(404, {}),
    );
    const result = await resolveStandaloneAuth();
    expect(result).toEqual({ ok: true, token: 'fresh-token', paired: true, name: 'Owner' });
    expect(localStorage.getItem('aside.standalone.token')).toBe('fresh-token');
    expect(window.location.hash).toBe('');
  });

  it('maps a 401 to pair_rejected and still scrubs the spent key', async () => {
    window.location.hash = `#pair=${CODE}`;
    stubFetch(() => json(401, { error: 'pair_failed' }));
    const result = await resolveStandaloneAuth();
    expect(result).toEqual({ ok: false, reason: 'pair_rejected' });
    expect(window.location.hash).toBe('');
  });

  it('re-opening an already-spent link on a paired phone just signs in', async () => {
    const held = tokenWithExpiry(3600);
    localStorage.setItem('aside.standalone.token', held);
    window.location.hash = `#pair=${CODE}`;
    stubFetch((url) =>
      url.includes('/api/pair')
        ? json(401, { error: 'pair_failed' })
        : json(200, { token: held }),
    );
    const result = await resolveStandaloneAuth();
    expect(result).toMatchObject({ ok: true, token: held, paired: false });
    expect(window.location.hash).toBe('');
  });

  it('a spent link with only the session cookie left recovers via /api/session', async () => {
    window.location.hash = `#pair=${CODE}`;
    stubFetch((url) =>
      url.includes('/api/pair')
        ? json(401, { error: 'pair_failed' })
        : json(200, { token: 'cookie-token', name: 'Owner' }),
    );
    const result = await resolveStandaloneAuth();
    expect(result).toMatchObject({ ok: true, token: 'cookie-token', paired: false });
  });

  it('maps a dead fetch to unreachable when the phone is online', async () => {
    window.location.hash = `#pair=${CODE}`;
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const result = await resolveStandaloneAuth();
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('maps a dead fetch to offline without waiting on failover', async () => {
    window.location.hash = `#pair=${CODE}`;
    setOnline(false);
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const startedAt = Date.now();
    const result = await resolveStandaloneAuth();
    expect(result).toEqual({ ok: false, reason: 'offline' });
    // Failover probes would take 5s+; the offline fast path skips them.
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });
});

describe('resolveStandaloneAuth without a pairing key', () => {
  it('boots on a stored token with life left, without a request', async () => {
    localStorage.setItem('aside.standalone.token', tokenWithExpiry(3600));
    const spy = vi.fn(async () => json(200, { token: 'x', expiresIn: 1 }));
    vi.stubGlobal('fetch', spy);
    const result = await resolveStandaloneAuth();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toContain('header.');
    // The background refresh may fire; the point is auth did not wait.
    expect(result.ok && result.paired).toBe(false);
  });

  it('recovers from the session cookie when storage is empty', async () => {
    stubFetch((url) =>
      url.endsWith('/api/session')
        ? json(200, { token: 'cookie-token', expiresIn: 7776000 })
        : json(404, {}),
    );
    const result = await resolveStandaloneAuth();
    expect(result).toEqual({ ok: true, token: 'cookie-token', paired: false, name: undefined });
  });

  it('maps a 401 recovery to needs_pairing', async () => {
    stubFetch(() => json(401, { error: 'unauthorized' }));
    const result = await resolveStandaloneAuth();
    expect(result).toEqual({ ok: false, reason: 'needs_pairing' });
  });

  it('still boots a stored token when offline, skipping the failover wait', async () => {
    // Expired, so the fast path does not take it -- but offline, a stale
    // token beats no boot, exactly as the online path already decided.
    localStorage.setItem('aside.standalone.token', tokenWithExpiry(-10));
    setOnline(false);
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const startedAt = Date.now();
    const result = await resolveStandaloneAuth();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.paired).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it('maps a dead recovery with nothing stored to offline', async () => {
    setOnline(false);
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const result = await resolveStandaloneAuth();
    expect(result).toEqual({ ok: false, reason: 'offline' });
  });
});
