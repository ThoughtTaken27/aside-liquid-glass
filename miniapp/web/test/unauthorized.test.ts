/**
 * A credential the server has stopped accepting.
 *
 * The boot path trusts a stored token on the strength of its own `exp`
 * claim, which is decoded locally and never checked against a signature, so
 * the app can launch without a spinner. Deleting the signing secret -- the
 * documented way to revoke a device -- leaves every issued token unexpired
 * and unverifiable at the same time, which that check cannot tell apart from
 * a healthy one.
 *
 * Reproduced on a real server before this was written: the phone rendered
 * the entire UI, got 401 on every call, swallowed all of them, and left the
 * owner pressing a send button that did nothing and displayed nothing. A 401
 * is the only authority on whether a credential is alive, so it is handled
 * centrally and at any point in a session rather than only at boot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setAuthToken, setUnauthorizedHandler } from '../src/api';

function stubStatus(status: number, body: unknown = { error: 'unauthorized' }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  setUnauthorizedHandler(null);
  setAuthToken('');
  vi.unstubAllGlobals();
});

describe('a 401 on an ordinary route', () => {
  it('reports the credential as dead rather than failing quietly', async () => {
    stubStatus(401);
    let fired = 0;
    setUnauthorizedHandler(() => {
      fired += 1;
    });
    await expect(api.sessions()).rejects.toBeInstanceOf(ApiError);
    expect(fired).toBe(1);
  });

  it('drops the in-memory token, so nothing retries with a known-bad one', async () => {
    stubStatus(401);
    setAuthToken('stale.token.value');
    setUnauthorizedHandler(() => undefined);
    await expect(api.sessions()).rejects.toBeInstanceOf(ApiError);

    // The next call must not carry the rejected bearer.
    stubStatus(200, { sessions: [] });
    await api.sessions();
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = new Headers((call[1] as RequestInit).headers);
    expect(headers.get('authorization')).toBeNull();
  });
});

describe('a 401 from the routes that mint a credential', () => {
  it('leaves a wrong pairing key to the caller', async () => {
    // Otherwise one fat-fingered paste wipes a perfectly good session.
    stubStatus(401, { error: 'pair_failed' });
    let fired = 0;
    setUnauthorizedHandler(() => {
      fired += 1;
    });
    await expect(api.pair('0'.repeat(32))).rejects.toBeInstanceOf(ApiError);
    expect(fired).toBe(0);
  });

  it('leaves a rejected Telegram initData to the caller', async () => {
    stubStatus(401, { error: 'bad_init_data' });
    let fired = 0;
    setUnauthorizedHandler(() => {
      fired += 1;
    });
    await expect(api.auth('nonsense')).rejects.toBeInstanceOf(ApiError);
    expect(fired).toBe(0);
  });
});

describe('other failures', () => {
  it('does not confuse a 500 with a dead credential', async () => {
    stubStatus(500, { error: 'boom' });
    let fired = 0;
    setUnauthorizedHandler(() => {
      fired += 1;
    });
    await expect(api.sessions()).rejects.toBeInstanceOf(ApiError);
    expect(fired).toBe(0);
  });

  it('does not require a handler to be registered', async () => {
    stubStatus(401);
    await expect(api.sessions()).rejects.toBeInstanceOf(ApiError);
  });
});
