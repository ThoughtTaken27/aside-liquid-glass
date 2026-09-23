/**
 * Client-side relay failover.
 *
 * Pure list-building is asserted directly; probing and navigation run
 * against a stubbed `location` and a mocked `fetch`, because the real ones
 * would navigate the test runner off the page. The failover entry point
 * carries module-level single-flight state, so those cases re-import a
 * fresh module rather than sharing it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  failoverCandidates,
  isOnBackup,
  isPublicOrigin,
  navigateToRelay,
  primaryRelay,
  probeOrigin,
  readInjectedRelays,
  relayDestinationUrl,
  setRefreshedRelays,
} from '../src/relays';

function stubLocation(origin: string, assign: (...args: unknown[]) => void = () => {}) {
  const url = new URL(origin);
  vi.stubGlobal('location', {
    origin,
    protocol: url.protocol,
    host: url.host,
    pathname: '/app',
    search: '',
    hash: '',
    assign,
  });
}

function injectMeta(content: string | null) {
  document.head.innerHTML =
    content === null
      ? ''
      : `<meta name="aside-relays" content="${content}" />`;
}

beforeEach(() => {
  setRefreshedRelays([]);
  injectMeta(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

describe('isPublicOrigin', () => {
  it.each([
    'https://mac.tailnet.ts.net',
    'https://aside-mac.ngrok-free.dev',
    'https://example.com:8443',
  ])('accepts %s', (value) => {
    expect(isPublicOrigin(value)).toBe(true);
  });

  it.each([
    '',
    'http://mac.tailnet.ts.net',
    'javascript:alert(1)',
    'https://*.example.com',
    'https://example.com/path',
    'https://example.com/',
  ])('rejects %s', (value) => {
    expect(isPublicOrigin(value)).toBe(false);
  });
});

describe('failover list', () => {
  it('reads the injected meta tag and drops invalid entries', () => {
    stubLocation('https://primary.example');
    injectMeta('https://primary.example https://backup.example javascript:alert(1)');
    expect(readInjectedRelays()).toEqual([
      'https://primary.example',
      'https://backup.example',
    ]);
  });

  it('is empty with no meta tag', () => {
    stubLocation('https://primary.example');
    expect(readInjectedRelays()).toEqual([]);
    expect(failoverCandidates()).toEqual([]);
  });

  it('orders injected first, then refreshed, minus the current origin', () => {
    stubLocation('https://primary.example');
    injectMeta('https://primary.example https://backup.example');
    setRefreshedRelays([
      'https://backup.example',
      'https://third.example',
      'not a url',
    ]);
    expect(failoverCandidates()).toEqual([
      'https://backup.example',
      'https://third.example',
    ]);
  });

  it('names the primary and knows when this page is on a backup', () => {
    injectMeta('https://primary.example https://backup.example');
    stubLocation('https://primary.example');
    expect(primaryRelay()).toBe('https://primary.example');
    expect(isOnBackup()).toBe(false);
    stubLocation('https://backup.example');
    expect(isOnBackup()).toBe(true);
    injectMeta(null);
    expect(primaryRelay()).toBeNull();
    expect(isOnBackup()).toBe(false);
  });
});

describe('probing', () => {
  it('reads same-origin health normally', async () => {
    stubLocation('https://primary.example');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new TypeError('down'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await probeOrigin('https://primary.example', 1000)).toBe(true);
    expect(await probeOrigin('https://primary.example', 1000)).toBe(false);
    expect(await probeOrigin('https://primary.example', 1000)).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('mode', 'no-cors');
  });

  it('treats any cross-origin answer as reachable (opaque no-cors)', async () => {
    stubLocation('https://primary.example');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TypeError('down'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await probeOrigin('https://backup.example', 1000)).toBe(true);
    expect(await probeOrigin('https://backup.example', 1000)).toBe(false);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://backup.example/api/health');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ mode: 'no-cors' });
  });
});

describe('navigation targets', () => {
  it('keeps path, query and hash across the hop', () => {
    vi.stubGlobal('location', {
      origin: 'https://primary.example',
      pathname: '/app/thread',
      search: '?q=1',
      hash: '#pair=abc',
      assign: () => {},
    });
    expect(relayDestinationUrl('https://backup.example')).toBe(
      'https://backup.example/app/thread?q=1#pair=abc',
    );
  });

  it('navigates to a relay but never to the origin it is already on', () => {
    const assign = vi.fn();
    stubLocation('https://primary.example', assign);
    navigateToRelay('https://backup.example');
    expect(assign).toHaveBeenCalledWith('https://backup.example/app');
    navigateToRelay('https://primary.example');
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

describe('failoverToHealthyRelay', () => {
  async function fresh() {
    vi.resetModules();
    return import('../src/relays');
  }

  it('does nothing with no candidates', async () => {
    stubLocation('https://primary.example');
    injectMeta(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const mod = await fresh();
    await expect(mod.failoverToHealthyRelay()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays put when the current origin answers', async () => {
    const assign = vi.fn();
    stubLocation('https://primary.example', assign);
    injectMeta('https://primary.example https://backup.example');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const mod = await fresh();
    await expect(mod.failoverToHealthyRelay()).resolves.toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it('moves to the first healthy relay when the current origin is dead', async () => {
    const assign = vi.fn();
    stubLocation('https://primary.example', assign);
    injectMeta('https://primary.example https://backup.example');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (String(url).startsWith('https://primary.example')) {
          return Promise.reject(new TypeError('down'));
        }
        return Promise.resolve(undefined);
      }),
    );
    const mod = await fresh();
    await expect(mod.failoverToHealthyRelay()).resolves.toBe(true);
    expect(assign).toHaveBeenCalledWith('https://backup.example/app');
  });

  it('stays put when every address is down', async () => {
    const assign = vi.fn();
    stubLocation('https://primary.example', assign);
    injectMeta('https://primary.example https://backup.example');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('down')));
    const mod = await fresh();
    await expect(mod.failoverToHealthyRelay()).resolves.toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it('never fails over from a non-standalone path', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', {
      origin: 'https://primary.example',
      pathname: '/',
      search: '',
      hash: '',
      assign,
    });
    injectMeta('https://primary.example https://backup.example');
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('down'));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await fresh();
    await expect(mod.failoverToHealthyRelay()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
