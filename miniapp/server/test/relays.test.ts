/**
 * Relay core: origin validation, registry ordering, and the two relay
 * supervisors with injected process execution (no real tailscale, no real
 * ngrok, no network).
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  createRelayRegistry,
  isPublicOrigin,
  toPublicOrigin,
  type RelayHandle,
  type RelayInfo,
} from '../src/relays.js';
import {
  disabledFunnel,
  funnelApplyArgs,
  funnelPlatformNote,
  funnelServesPort,
  startFunnel,
  tailscaleAttempts,
} from '../src/funnel.js';
import type { PublicProbeResult } from '../src/publicprobe.js';
import {
  disabledNgrok,
  ngrokArgs,
  publicUrlFromAgentApi,
  resolveNgrokBin,
  startNgrok,
} from '../src/ngrok.js';

function stubHandle(
  kind: 'funnel' | 'ngrok',
  url: string | null,
): RelayHandle & { stopCalls: number } {
  const handle = {
    kind,
    stopCalls: 0,
    snapshot: (): RelayInfo => ({ kind, url, healthy: url ? true : null, detail: null }),
    stop: async (): Promise<void> => {
      handle.stopCalls += 1;
    },
  };
  return handle;
}

describe('isPublicOrigin', () => {
  it.each([
    'https://mac.tailnet.ts.net',
    'https://aside-mac.ngrok-free.dev',
    'https://example.com:8443',
    'https://a-b.c9-d.example.co.uk',
  ])('accepts %s', (value) => {
    expect(isPublicOrigin(value)).toBe(true);
  });

  it.each([
    '',
    'http://mac.tailnet.ts.net',
    'javascript:alert(1)',
    'https://*.example.com',
    'https://example.com/path',
    'https://example.com?x=1',
    'https://example.com#frag',
    'https://example.com/',
    'https://exa mple.com',
    'https://',
    'not a url',
    'ftp://example.com',
  ])('rejects %s', (value) => {
    expect(isPublicOrigin(value)).toBe(false);
  });
});

describe('toPublicOrigin', () => {
  it('normalizes scheme and trailing slashes away', () => {
    expect(toPublicOrigin('https://mac.tailnet.ts.net/')).toBe('https://mac.tailnet.ts.net');
    expect(toPublicOrigin('http://aside-mac.ngrok-free.dev//')).toBe(
      'https://aside-mac.ngrok-free.dev',
    );
    expect(toPublicOrigin('mac.tailnet.ts.net')).toBe('https://mac.tailnet.ts.net');
  });

  it('returns null for garbage rather than fixing it up', () => {
    expect(toPublicOrigin('')).toBeNull();
    expect(toPublicOrigin('https://')).toBeNull();
    expect(toPublicOrigin('https://exa mple.com')).toBeNull();
    expect(toPublicOrigin('javascript:alert(1)')).toBeNull();
  });
});

describe('relay registry', () => {
  it('orders funnel before ngrok and skips relays without a URL', () => {
    const registry = createRelayRegistry();
    registry.register(stubHandle('ngrok', 'https://aside-mac.ngrok-free.dev'));
    registry.register(stubHandle('funnel', null));
    expect(registry.orderedUrls()).toEqual([
      { kind: 'ngrok', url: 'https://aside-mac.ngrok-free.dev' },
    ]);
    expect(registry.primary()).toEqual({
      kind: 'ngrok',
      url: 'https://aside-mac.ngrok-free.dev',
    });
    registry.register(stubHandle('funnel', 'https://mac.tailnet.ts.net'));
    expect(registry.orderedUrls()).toEqual([
      { kind: 'funnel', url: 'https://mac.tailnet.ts.net' },
      { kind: 'ngrok', url: 'https://aside-mac.ngrok-free.dev' },
    ]);
    expect(registry.primary()).toEqual({
      kind: 'funnel',
      url: 'https://mac.tailnet.ts.net',
    });
  });

  it('drops invalid URLs rather than handing them to the phone', () => {
    const registry = createRelayRegistry();
    registry.register(stubHandle('funnel', 'javascript:alert(1)'));
    expect(registry.orderedUrls()).toEqual([]);
    expect(registry.primary()).toBeNull();
  });

  it('snapshots unregistered relays as disabled', () => {
    const registry = createRelayRegistry();
    expect(registry.snapshot()).toEqual([
      { kind: 'funnel', url: null, healthy: null, detail: 'disabled' },
      { kind: 'ngrok', url: null, healthy: null, detail: 'disabled' },
    ]);
  });

  it('waitForUrl resolves immediately when a URL is already verified', async () => {
    const registry = createRelayRegistry();
    registry.register(stubHandle('funnel', 'https://mac.tailnet.ts.net'));
    await expect(registry.waitForUrl(50)).resolves.toEqual({
      kind: 'funnel',
      url: 'https://mac.tailnet.ts.net',
    });
  });

  it('waitForUrl resolves when a relay verifies mid-wait, else null', async () => {
    const registry = createRelayRegistry();
    setTimeout(() => {
      registry.register(stubHandle('ngrok', 'https://aside-mac.ngrok-free.dev'));
    }, 300);
    await expect(registry.waitForUrl(2000)).resolves.toEqual({
      kind: 'ngrok',
      url: 'https://aside-mac.ngrok-free.dev',
    });
    const empty = createRelayRegistry();
    await expect(empty.waitForUrl(300)).resolves.toBeNull();
  });

  it('stopAll tolerates a relay that throws on stop', async () => {
    const registry = createRelayRegistry();
    const good = stubHandle('funnel', null);
    registry.register(good);
    registry.register({
      kind: 'ngrok',
      snapshot: (): RelayInfo => ({ kind: 'ngrok', url: null, healthy: null, detail: null }),
      stop: async (): Promise<void> => {
        throw new Error('already dead');
      },
    });
    await registry.stopAll();
    expect(good.stopCalls).toBe(1);
  });

  it('re-registering a kind replaces the old handle', () => {
    const registry = createRelayRegistry();
    registry.register(stubHandle('funnel', 'https://one.example'));
    registry.register(stubHandle('funnel', 'https://two.example'));
    expect(registry.orderedUrls()).toEqual([{ kind: 'funnel', url: 'https://two.example' }]);
  });
});

describe('funnel status parsing', () => {
  const port = 8790;

  function statusDoc(proxy: string | null, funnel: boolean): unknown {
    return {
      Web: {
        'mac.tailnet.ts.net:443': {
          Handlers: proxy ? { '/': { Proxy: proxy } } : {},
        },
      },
      AllowFunnel: funnel ? { 'mac.tailnet.ts.net:443': true } : {},
    };
  }

  it('is true for our loopback proxy plus AllowFunnel', () => {
    expect(funnelServesPort(statusDoc('http://127.0.0.1:8790', true), port)).toBe(true);
  });

  it('is false when the proxied port is some other service', () => {
    expect(funnelServesPort(statusDoc('http://127.0.0.1:3000', true), port)).toBe(false);
  });

  it('is false for serve without funnel (tailnet-only is not public)', () => {
    expect(funnelServesPort(statusDoc('http://127.0.0.1:8790', false), port)).toBe(false);
  });

  it('is false when funnel serves but our port is missing', () => {
    expect(funnelServesPort(statusDoc(null, true), port)).toBe(false);
  });

  it.each([null, undefined, 42, 'nope', [], {}])('is false for %s', (value) => {
    expect(funnelServesPort(value, port)).toBe(false);
  });

  it('builds loopback-pinned persistent apply args', () => {
    expect(funnelApplyArgs(8790)).toEqual(['funnel', '--bg', 'http://127.0.0.1:8790']);
  });
});

describe('tailscale CLI resolution', () => {
  const savedCli = process.env.TAILSCALE_CLI;

  beforeEach(() => {
    delete process.env.TAILSCALE_CLI;
  });

  afterEach(() => {
    if (savedCli === undefined) delete process.env.TAILSCALE_CLI;
    else process.env.TAILSCALE_CLI = savedCli;
  });

  it('prefers an explicit binary that exists', () => {
    const attempts = tailscaleAttempts(process.execPath);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0]?.binary).toBe(process.execPath);
  });

  it('ignores binaries that do not exist', () => {
    const attempts = tailscaleAttempts('/nonexistent/tailscale');
    expect(attempts.every((attempt) => attempt.binary !== '/nonexistent/tailscale')).toBe(true);
  });
});

describe('funnel supervisor', () => {
  const handles: RelayHandle[] = [];
  const savedCli = process.env.TAILSCALE_CLI;

  const passingProbe = async (): Promise<PublicProbeResult> => ({
    ok: true,
    viaIp: '203.0.113.7',
    publicPath: true,
  });

  beforeEach(() => {
    delete process.env.TAILSCALE_CLI;
  });

  afterEach(async () => {
    if (savedCli === undefined) delete process.env.TAILSCALE_CLI;
    else process.env.TAILSCALE_CLI = savedCli;
    while (handles.length) {
      const handle = handles.pop();
      if (handle) await handle.stop();
    }
  });

  function track<T extends RelayHandle>(handle: T): T {
    handles.push(handle);
    return handle;
  }

  it('is disabled with a hint when no CLI exists', async () => {
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: '/nonexistent/tailscale',
        readTailnetHost: () => 'mac.tailnet.ts.net',
        exec: async () => {
          throw new Error('must not run');
        },
      }),
    );
    expect(handle.snapshot().url).toBeNull();
    expect(handle.snapshot().detail).toMatch(/CLI not found/);
  });

  it('applies funnel when the port is missing, then advertises the URL', async () => {
    const calls: string[][] = [];
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: process.execPath,
        readTailnetHost: () => 'mac.tailnet.ts.net',
        checkIntervalMs: 60_000,
        verifyEndpoint: passingProbe,
        exec: async (_binary, args) => {
          calls.push(args);
          if (args[0] === 'serve') {
            return JSON.stringify({
              Web: { 'mac.tailnet.ts.net:443': { Handlers: {} } },
              AllowFunnel: {},
            });
          }
          return '';
        },
      }),
    );
    expect(calls.map((args) => args[0])).toEqual(['serve', 'funnel']);
    expect(calls[1]).toEqual(['funnel', '--bg', 'http://127.0.0.1:8790']);
    expect(handle.snapshot()).toMatchObject({
      kind: 'funnel',
      url: 'https://mac.tailnet.ts.net',
      healthy: true,
    });
  });

  it('does not re-apply when the port is already funneled', async () => {
    const calls: string[][] = [];
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: process.execPath,
        readTailnetHost: () => 'mac.tailnet.ts.net',
        checkIntervalMs: 60_000,
        verifyEndpoint: passingProbe,
        exec: async (_binary, args) => {
          calls.push(args);
          return JSON.stringify({
            Web: {
              'mac.tailnet.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } },
              },
            },
            AllowFunnel: { 'mac.tailnet.ts.net:443': true },
          });
        },
      }),
    );
    expect(calls.map((args) => args[0])).toEqual(['serve']);
    expect(handle.snapshot().url).toBe('https://mac.tailnet.ts.net');
  });

  it('reports no URL while the tailnet has no DNS name', async () => {
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: process.execPath,
        readTailnetHost: () => null,
        checkIntervalMs: 60_000,
        verifyEndpoint: async () => {
          throw new Error('must not probe without DNS');
        },
        exec: async () => {
          throw new Error('must not run without DNS');
        },
      }),
    );
    expect(handle.snapshot().url).toBeNull();
    expect(handle.snapshot().detail).toMatch(/not connected/);
  });

  it('waits for the tailnet cache at boot instead of reporting down', async () => {
    // `primeTailnetHost()` resolves asynchronously, so the cache is empty
    // when the supervisor boots. Without the boot-wait the first check
    // always concluded "not connected" and the relay sat unverified for a
    // full watchdog interval.
    let dns: string | null = null;
    setTimeout(() => {
      dns = 'mac.tailnet.ts.net';
    }, 600);
    const calls: string[][] = [];
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: process.execPath,
        readTailnetHost: () => dns,
        checkIntervalMs: 60_000,
        verifyEndpoint: passingProbe,
        exec: async (_binary, args) => {
          calls.push(args);
          return JSON.stringify({
            Web: {
              'mac.tailnet.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } },
              },
            },
            AllowFunnel: { 'mac.tailnet.ts.net:443': true },
          });
        },
      }),
    );
    expect(calls.map((args) => args[0])).toEqual(['serve']);
    expect(handle.snapshot().url).toBe('https://mac.tailnet.ts.net');
  });

  it('names the admin-console fix when funnel is not enabled', async () => {
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: process.execPath,
        readTailnetHost: () => 'mac.tailnet.ts.net',
        checkIntervalMs: 60_000,
        exec: async (_binary, args) => {
          if (args[0] === 'serve') {
            return JSON.stringify({ Web: {}, AllowFunnel: {} });
          }
          const err = new Error('tailscale funnel failed') as Error & { stderr?: string };
          err.stderr = 'Error: Funnel is not enabled; see https://tailscale.com/s/no-funnel\n';
          throw err;
        },
      }),
    );
    expect(handle.snapshot().url).toBeNull();
    expect(handle.snapshot().detail).toMatch(/admin console/);
  });

  it('disabledFunnel never advertises and stops cleanly', async () => {
    const handle = disabledFunnel('off in tests');
    expect(handle.snapshot()).toEqual({
      kind: 'funnel',
      url: null,
      healthy: null,
      detail: 'off in tests',
    });
    await handle.stop();
  });

  it('withholds the URL when the config reads fine but the probe fails', async () => {
    // The incident shape: AllowFunnel plus our proxy in the status, while
    // the public TLS handshake stalls with zero bytes. The relay must read
    // as broken (healthy false, stage-named detail), never advertised.
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: process.execPath,
        readTailnetHost: () => 'mac.tailnet.ts.net',
        checkIntervalMs: 60_000,
        verifyEndpoint: async (): Promise<PublicProbeResult> => ({
          ok: false,
          stage: 'tls',
          detail: 'TLS handshake to mac.tailnet.ts.net timed out',
          viaIp: '203.0.113.7',
        }),
        exec: async () =>
          JSON.stringify({
            Web: {
              'mac.tailnet.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } },
              },
            },
            AllowFunnel: { 'mac.tailnet.ts.net:443': true },
          }),
      }),
    );
    expect(handle.snapshot().url).toBeNull();
    expect(handle.snapshot().healthy).toBe(false);
    expect(handle.snapshot().detail).toMatch(/not answering/);
    expect(handle.snapshot().detail).toMatch(/tls/);
  });

  it('a probe throw reads as down, not a crash', async () => {
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: process.execPath,
        readTailnetHost: () => 'mac.tailnet.ts.net',
        checkIntervalMs: 60_000,
        verifyEndpoint: async () => {
          throw new Error('probe blew up');
        },
        exec: async () =>
          JSON.stringify({
            Web: {
              'mac.tailnet.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } },
              },
            },
            AllowFunnel: { 'mac.tailnet.ts.net:443': true },
          }),
      }),
    );
    expect(handle.snapshot().url).toBeNull();
    expect(handle.snapshot().healthy).toBe(false);
    expect(handle.snapshot().detail).toMatch(/probe failed/);
  });

  it('re-applies after repeated probe failures, at most on backoff', async () => {
    const calls: string[][] = [];
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: process.execPath,
        readTailnetHost: () => 'mac.tailnet.ts.net',
        checkIntervalMs: 20,
        verifyEndpoint: async (): Promise<PublicProbeResult> => ({
          ok: false,
          stage: 'tls',
          detail: 'TLS handshake timed out',
          viaIp: '203.0.113.7',
        }),
        exec: async (_binary, args) => {
          calls.push(args);
          return JSON.stringify({
            Web: {
              'mac.tailnet.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } },
              },
            },
            AllowFunnel: { 'mac.tailnet.ts.net:443': true },
          });
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await handle.stop();
    // Many status reads over ~15 ticks, but exactly one re-apply: the
    // backoff gate holds after the first.
    expect(calls.filter((args) => args[0] === 'serve').length).toBeGreaterThan(3);
    const reapplies = calls.filter((args) => args[0] === 'funnel');
    expect(reapplies).toHaveLength(1);
    expect(reapplies[0]).toEqual(['funnel', '--bg', 'http://127.0.0.1:8790']);
  });

  it('never re-applies for DNS-stage failures', async () => {
    // Re-registering cannot hurry public DNS propagation, and churning
    // enables risks the Let's Encrypt rate limit.
    const calls: string[][] = [];
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: process.execPath,
        readTailnetHost: () => 'mac.tailnet.ts.net',
        checkIntervalMs: 20,
        verifyEndpoint: async (): Promise<PublicProbeResult> => ({
          ok: false,
          stage: 'dns',
          detail: 'mac.tailnet.ts.net does not resolve yet',
          viaIp: null,
        }),
        exec: async (_binary, args) => {
          calls.push(args);
          return JSON.stringify({
            Web: {
              'mac.tailnet.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } },
              },
            },
            AllowFunnel: { 'mac.tailnet.ts.net:443': true },
          });
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    await handle.stop();
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every((args) => args[0] === 'serve')).toBe(true);
    expect(handle.snapshot().healthy).toBe(false);
  });

  it('recovers the URL when the probe starts passing', async () => {
    let probes = 0;
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: process.execPath,
        readTailnetHost: () => 'mac.tailnet.ts.net',
        checkIntervalMs: 20,
        verifyEndpoint: async (): Promise<PublicProbeResult> => {
          probes += 1;
          return probes <= 2
            ? { ok: false, stage: 'tcp', detail: 'refused', viaIp: '203.0.113.7' }
            : { ok: true, viaIp: '203.0.113.7', publicPath: true };
        },
        exec: async () =>
          JSON.stringify({
            Web: {
              'mac.tailnet.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } },
              },
            },
            AllowFunnel: { 'mac.tailnet.ts.net:443': true },
          }),
      }),
    );
    expect(handle.snapshot().url).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(handle.snapshot()).toMatchObject({
      url: 'https://mac.tailnet.ts.net',
      healthy: true,
      detail: null,
    });
  });

  it('does not advertise a fresh apply until the probe passes', async () => {
    const handle = track(
      await startFunnel({
        port: 8790,
        tailscaleCli: process.execPath,
        readTailnetHost: () => 'mac.tailnet.ts.net',
        checkIntervalMs: 60_000,
        verifyEndpoint: async (): Promise<PublicProbeResult> => ({
          ok: false,
          stage: 'dns',
          detail: 'mac.tailnet.ts.net does not resolve yet',
          viaIp: null,
        }),
        exec: async (_binary, args) => {
          if (args[0] === 'serve') {
            return JSON.stringify({
              Web: { 'mac.tailnet.ts.net:443': { Handlers: {} } },
              AllowFunnel: {},
            });
          }
          return '';
        },
      }),
    );
    // The apply ran (no throw), but the URL stays dark until dialable.
    expect(handle.snapshot().url).toBeNull();
    expect(handle.snapshot().healthy).toBe(false);
    expect(handle.snapshot().detail).toMatch(/dns/);
  });
});

describe('funnel macOS variant note', () => {
  it('names the requirement on darwin without the app bundle', () => {
    expect(funnelPlatformNote('darwin', false)).toMatch(/Tailscale.app/);
    expect(funnelPlatformNote('darwin', false)).toMatch(/App Store or Standalone/);
  });

  it('stays quiet when the app is present or the platform is not macOS', () => {
    expect(funnelPlatformNote('darwin', true)).toBeNull();
    expect(funnelPlatformNote('linux', false)).toBeNull();
  });
});

describe('ngrok agent parsing', () => {
  it('picks the https public URL', () => {
    expect(
      publicUrlFromAgentApi({
        tunnels: [{ public_url: 'https://aside-mac.ngrok-free.dev', proto: 'https' }],
      }),
    ).toBe('https://aside-mac.ngrok-free.dev');
  });

  it('ignores non-https and malformed entries', () => {
    expect(
      publicUrlFromAgentApi({
        tunnels: [{ public_url: 'http://aside-mac.ngrok-free.dev' }, { nope: true }],
      }),
    ).toBeNull();
  });

  it.each([null, undefined, {}, { tunnels: 'nope' }, { tunnels: [] }])(
    'returns null for %s',
    (value) => {
      expect(publicUrlFromAgentApi(value)).toBeNull();
    },
  );

  it('pins the static domain and the loopback target', () => {
    expect(ngrokArgs(8790, 'https://aside-mac.ngrok-free.dev/')).toEqual([
      'http',
      'http://127.0.0.1:8790',
      '--url',
      'aside-mac.ngrok-free.dev',
    ]);
  });

  it('resolves the binary explicit-first, then env, then PATH', () => {
    const saved = process.env.NGROK_BIN;
    try {
      expect(resolveNgrokBin('/custom/ngrok')).toBe('/custom/ngrok');
      process.env.NGROK_BIN = '/env/ngrok';
      expect(resolveNgrokBin()).toBe('/env/ngrok');
      expect(resolveNgrokBin('/custom/ngrok')).toBe('/custom/ngrok');
      delete process.env.NGROK_BIN;
      expect(resolveNgrokBin()).toBe('ngrok');
    } finally {
      if (saved === undefined) delete process.env.NGROK_BIN;
      else process.env.NGROK_BIN = saved;
    }
  });
});

describe('ngrok supervisor', () => {
  const handles: RelayHandle[] = [];

  afterEach(async () => {
    while (handles.length) {
      const handle = handles.pop();
      if (handle) await handle.stop();
    }
  });

  function track<T extends RelayHandle>(handle: T): T {
    handles.push(handle);
    return handle;
  }

  interface FakeChild {
    killed: boolean;
    on(event: string, cb: (...args: never[]) => void): FakeChild;
    kill(): boolean;
    emit(event: string, ...args: never[]): void;
  }

  function fakeChild(): FakeChild {
    const listeners = new Map<string, (...args: never[]) => void>();
    const child: FakeChild = {
      killed: false,
      on(event: string, cb: (...args: never[]) => void) {
        listeners.set(event, cb);
        return child;
      },
      kill() {
        child.killed = true;
        return true;
      },
      emit(event: string, ...args: never[]) {
        listeners.get(event)?.(...args);
      },
    };
    return child;
  }

  it('stays disabled without a domain, and says which knob is missing', async () => {
    const handle = await startNgrok({
      port: 8790,
      domain: '',
      authtoken: 'token',
      spawnChild: () => {
        throw new Error('must not spawn');
      },
    });
    expect(handle.snapshot().url).toBeNull();
    expect(handle.snapshot().detail).toMatch(/ngrok_domain/);
    await handle.stop();
  });

  it('stays disabled without an authtoken, and says which knob is missing', async () => {
    const handle = await startNgrok({
      port: 8790,
      domain: 'aside-mac.ngrok-free.dev',
      authtoken: '   ',
      spawnChild: () => {
        throw new Error('must not spawn');
      },
    });
    expect(handle.snapshot().url).toBeNull();
    expect(handle.snapshot().detail).toMatch(/NGROK_AUTHTOKEN/);
    await handle.stop();
  });

  it('spawns with the token in env only, and advertises once confirmed', async () => {
    const spawns: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const child = fakeChild();
    const handle = track(
      await startNgrok({
        port: 8790,
        domain: 'aside-mac.ngrok-free.dev',
        authtoken: 'sekret-token',
        checkIntervalMs: 60_000,
        spawnChild: (bin, args, env) => {
          spawns.push({ bin, args, env });
          // The token must travel by environment, never on the command line
          // where `ps` would show it to every user on the machine.
          expect(args.join(' ')).not.toContain('sekret-token');
          expect(env.NGROK_AUTHTOKEN).toBe('sekret-token');
          return child as never;
        },
        readAgentApi: async () => ({
          tunnels: [{ public_url: 'https://aside-mac.ngrok-free.dev' }],
        }),
      }),
    );
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.args).toEqual([
      'http',
      'http://127.0.0.1:8790',
      '--url',
      'aside-mac.ngrok-free.dev',
    ]);
    expect(handle.snapshot()).toMatchObject({
      kind: 'ngrok',
      url: 'https://aside-mac.ngrok-free.dev',
      healthy: true,
    });
  });

  it('ignores a confirmed tunnel for somebody else\'s domain', async () => {
    const child = fakeChild();
    const handle = track(
      await startNgrok({
        port: 8790,
        domain: 'aside-mac.ngrok-free.dev',
        authtoken: 'sekret-token',
        checkIntervalMs: 60_000,
        startupTimeoutMs: 1200,
        spawnChild: () => child as never,
        readAgentApi: async () => ({
          tunnels: [{ public_url: 'https://someone-else.ngrok-free.dev' }],
        }),
      }),
    );
    expect(handle.snapshot().url).toBeNull();
    expect(child.killed).toBe(true);
    expect(handle.snapshot().detail).toMatch(/never came up/);
    // The kill's own exit event must not clobber the precise detail with a
    // generic "exited" line.
    child.emit('exit', null as never);
    expect(handle.snapshot().detail).toMatch(/never came up/);
  });

  it('surfaces a missing binary as a detail, not a crash', async () => {
    const handle = track(
      await startNgrok({
        port: 8790,
        domain: 'aside-mac.ngrok-free.dev',
        authtoken: 'sekret-token',
        checkIntervalMs: 60_000,
        spawnChild: () => {
          throw new Error('spawn ngrok ENOENT');
        },
        readAgentApi: async () => ({ tunnels: [] }),
      }),
    );
    expect(handle.snapshot().url).toBeNull();
    expect(handle.snapshot().detail).toMatch(/cannot start ngrok/);
  });

  it('disabledNgrok never advertises and stops cleanly', async () => {
    const handle = disabledNgrok('off in tests');
    expect(handle.snapshot()).toEqual({
      kind: 'ngrok',
      url: null,
      healthy: null,
      detail: 'off in tests',
    });
    await handle.stop();
  });
});
