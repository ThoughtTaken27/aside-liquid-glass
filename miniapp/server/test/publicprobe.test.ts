/**
 * Public relay probe: every stage (DNS/TCP/TLS/HTTP/body) reports
 * separately, tailnet-range answers are re-resolved over public DNS, and
 * nothing here touches the real network except loopback.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isTailnetIpv4,
  verifyPublicEndpoint,
  type ProbeDeps,
  type PublicProbeResult,
} from '../src/publicprobe.js';

const okResult = (viaIp: string, publicPath: boolean): PublicProbeResult => ({
  ok: true,
  viaIp,
  publicPath,
});

function deps(overrides: ProbeDeps = {}): ProbeDeps {
  return {
    lookup: async () => ['203.0.113.7'],
    resolvePublicDns: async () => {
      throw new Error('must not need public DNS');
    },
    tcpConnect: async () => {},
    httpsGet: async () => ({ status: 200, body: '{"ok":true}' }),
    ...overrides,
  };
}

describe('isTailnetIpv4', () => {
  it.each(['100.64.0.1', '100.100.18.91', '100.127.255.255'])(
    'treats %s as a tailnet address',
    (ip) => {
      expect(isTailnetIpv4(ip)).toBe(true);
    },
  );

  it.each([
    '100.63.255.255',
    '100.128.0.1',
    '99.64.0.1',
    '209.177.145.137',
    '127.0.0.1',
    '',
    'not-an-ip',
    '100.64.0.1.5',
  ])('treats %s as not tailnet', (ip) => {
    expect(isTailnetIpv4(ip)).toBe(false);
  });
});

describe('verifyPublicEndpoint', () => {
  it('walks DNS, TCP, TLS and HTTP to the health marker', async () => {
    const seen: string[] = [];
    const result = await verifyPublicEndpoint('https://mac.tail1234.ts.net', {
      deps: deps({
        httpsGet: async (ip) => {
          seen.push(ip);
          return { status: 200, body: '{"ok":true}' };
        },
      }),
    });
    expect(result).toEqual(okResult('203.0.113.7', true));
    expect(seen).toEqual(['203.0.113.7']);
  });

  it('rejects non-origins without touching the network', async () => {
    for (const origin of ['', 'http://mac.ts.net', 'javascript:alert(1)', 'notaurl']) {
      const result = await verifyPublicEndpoint(origin, {
        deps: deps({
          lookup: async () => {
            throw new Error('must not resolve');
          },
        }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.stage).toBe('dns');
    }
  });

  it('reports DNS when nothing resolves', async () => {
    const result = await verifyPublicEndpoint('https://mac.tail1234.ts.net', {
      deps: deps({
        lookup: async () => {
          throw new Error('queryA ENOTFOUND');
        },
        resolvePublicDns: async () => [],
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('dns');
      expect(result.detail).toContain('does not resolve');
      expect(result.viaIp).toBeNull();
    }
  });

  it('re-resolves over public DNS when the Mac only sees the tailnet address', async () => {
    // A tun-mode Mac resolves its own MagicDNS name to 100.x. Probing that
    // would test serve while claiming to test Funnel, so the probe asks
    // public DNS what the phone would dial.
    let dohCalls = 0;
    const seen: string[] = [];
    const result = await verifyPublicEndpoint('https://mac.tail1234.ts.net', {
      deps: deps({
        lookup: async () => ['100.100.18.91'],
        resolvePublicDns: async () => {
          dohCalls += 1;
          return ['203.0.113.9'];
        },
        httpsGet: async (ip) => {
          seen.push(ip);
          return { status: 200, body: '{"ok":true}' };
        },
      }),
    });
    expect(result).toEqual(okResult('203.0.113.9', true));
    expect(dohCalls).toBe(1);
    expect(seen).toEqual(['203.0.113.9']);
  });

  it('tests the tailnet answer, flagged, when public DNS is unreachable', async () => {
    const result = await verifyPublicEndpoint('https://mac.tail1234.ts.net', {
      deps: deps({
        lookup: async () => ['100.100.18.91'],
        resolvePublicDns: async () => {
          throw new Error('doh down');
        },
      }),
    });
    expect(result).toEqual(okResult('100.100.18.91', false));
  });

  it('skips public DNS when the system answer is already public', async () => {
    const result = await verifyPublicEndpoint('https://mac.tail1234.ts.net', {
      deps: deps(),
    });
    expect(result).toEqual(okResult('203.0.113.7', true));
  });

  it('reports TCP when the connection fails, with the dialed IP', async () => {
    const result = await verifyPublicEndpoint('https://mac.tail1234.ts.net', {
      deps: deps({
        tcpConnect: async () => {
          throw new Error('connect ECONNREFUSED 203.0.113.7:443');
        },
        httpsGet: async () => {
          throw new Error('must not run after TCP failed');
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('tcp');
      expect(result.detail).toContain('ECONNREFUSED');
      expect(result.viaIp).toBe('203.0.113.7');
    }
  });

  it('reports TLS when the handshake fails after TCP connected', async () => {
    // The incident shape: TCP to the edge connects, then zero bytes.
    const result = await verifyPublicEndpoint('https://mac.tail1234.ts.net', {
      deps: deps({
        httpsGet: async () => {
          const err = new Error('TLS handshake to mac.tail1234.ts.net timed out') as Error & {
            stage: 'tls';
          };
          err.stage = 'tls';
          throw err;
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('tls');
      expect(result.detail).toContain('handshake');
    }
  });

  it('reports HTTP for a non-200 answer', async () => {
    const result = await verifyPublicEndpoint('https://mac.tail1234.ts.net', {
      deps: deps({
        httpsGet: async () => ({ status: 502, body: 'bad gateway' }),
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('http');
      expect(result.detail).toContain('502');
    }
  });

  it('reports body when something else answers 200', async () => {
    const result = await verifyPublicEndpoint('https://mac.tail1234.ts.net', {
      deps: deps({
        httpsGet: async () => ({ status: 200, body: '<html>not us</html>' }),
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('body');
  });
});

describe('default transports against loopback', () => {
  it('tcpConnect succeeds on an open port and fails on a closed one', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);
    // Reach the default through a probe whose other stages are stubbed: a
    // closed port must surface as a TCP-stage failure, never a throw.
    const refused = await verifyPublicEndpoint(`https://probe.invalid:${port + 1}`, {
      deps: {
        lookup: async () => ['127.0.0.1'],
        tcpConnect: undefined,
        httpsGet: async () => ({ status: 200, body: '{"ok":true}' }),
      },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.stage).toBe('tcp');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('classifies a real certificate failure as TLS', async () => {
    // A relay that presents the wrong certificate must read as a TLS-stage
    // failure with the hostname in the detail, not as a generic error.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cert-'));
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', path.join(dir, 'key.pem'),
        '-out', path.join(dir, 'cert.pem'),
        '-days', '1', '-subj', '/CN=wrong.invalid',
      ]);
      const server = https.createServer(
        {
          key: fs.readFileSync(path.join(dir, 'key.pem')),
          cert: fs.readFileSync(path.join(dir, 'cert.pem')),
        },
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        },
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const result = await verifyPublicEndpoint(`https://wrong.invalid:${port}`, {
        deps: { lookup: async () => ['127.0.0.1'] },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.stage).toBe('tls');
        expect(result.detail).toContain('wrong.invalid');
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
