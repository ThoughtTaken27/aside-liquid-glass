/**
 * Relay wiring: config parsing, the /api/relays route, the CSP sources,
 * and the failover meta tag on the standalone shell.
 *
 * The supervisors themselves (process execution, status parsing) live in
 * relays.test.ts with injected execution; this file pins how they plug
 * into the server around them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { mintToken } from '../src/auth.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { makeTestEnv, OWNER_ID, type TestEnv } from './helpers.js';

const RELAY_ENV = [
  'MINIAPP_RELAY_FUNNEL',
  'MINIAPP_RELAY_NGROK',
  'MINIAPP_NGROK_DOMAIN',
  'NGROK_AUTHTOKEN',
] as const;
let savedEnv: Array<string | undefined> = [];
let configEnv: TestEnv | undefined;

beforeEach(() => {
  savedEnv = RELAY_ENV.map((name) => process.env[name]);
  for (const name of RELAY_ENV) delete process.env[name];
});

afterEach(() => {
  RELAY_ENV.forEach((name, index) => {
    const value = savedEnv[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
  configEnv?.cleanup();
  configEnv = undefined;
});

const withMiniapp = (section: Record<string, unknown>) => {
  configEnv = makeTestEnv({ miniapp: section });
  return loadConfig();
};

describe('relay config', () => {
  it('enables both relays by default', () => {
    const config = withMiniapp({});
    expect(config.miniapp.relayFunnel).toBe(true);
    expect(config.miniapp.relayNgrok).toBe(true);
    expect(config.miniapp.ngrokDomain).toBe('');
    expect(config.miniapp.ngrokAuthtoken).toBe('');
  });

  it('lets env disable each relay independently', () => {
    process.env.MINIAPP_RELAY_FUNNEL = '0';
    expect(withMiniapp({}).miniapp.relayFunnel).toBe(false);
    expect(withMiniapp({}).miniapp.relayNgrok).toBe(true);
    process.env.MINIAPP_RELAY_NGROK = 'false';
    expect(withMiniapp({}).miniapp.relayNgrok).toBe(false);
  });

  it('lets env re-enable a relay the config disabled', () => {
    process.env.MINIAPP_RELAY_FUNNEL = '1';
    expect(withMiniapp({ relay_funnel: false }).miniapp.relayFunnel).toBe(true);
  });

  it('honours a config false with no env set', () => {
    const config = withMiniapp({ relay_funnel: false, relay_ngrok: false });
    expect(config.miniapp.relayFunnel).toBe(false);
    expect(config.miniapp.relayNgrok).toBe(false);
  });

  it('normalizes the ngrok domain like a tunnel hostname', () => {
    const config = withMiniapp({ ngrok_domain: 'https://Aside-Mac.ngrok-free.dev/' });
    expect(config.miniapp.ngrokDomain).toBe('aside-mac.ngrok-free.dev');
    process.env.MINIAPP_NGROK_DOMAIN = 'other.ngrok-free.dev';
    expect(withMiniapp({ ngrok_domain: 'aside-mac.ngrok-free.dev' }).miniapp.ngrokDomain).toBe(
      'other.ngrok-free.dev',
    );
  });

  it('prefers the NGROK_AUTHTOKEN env over the config file', () => {
    expect(
      withMiniapp({ ngrok_authtoken: 'from-config' }).miniapp.ngrokAuthtoken,
    ).toBe('from-config');
    process.env.NGROK_AUTHTOKEN = 'from-env';
    expect(
      withMiniapp({ ngrok_authtoken: 'from-config' }).miniapp.ngrokAuthtoken,
    ).toBe('from-env');
  });
});

describe('relay routes and headers', () => {
  let env: TestEnv;
  let secret: string;
  let webDist: string;
  let app: FastifyInstance | null = null;

  const SHELL = '<!doctype html><html><head><title>Aside</title></head><body></body></html>';

  beforeEach(() => {
    env = makeTestEnv();
    const config = loadConfig();
    secret = loadOrCreateJwtSecret(config.secretPath);
    webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dist-'));
    fs.writeFileSync(path.join(webDist, 'index.html'), SHELL);
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    fs.rmSync(webDist, { recursive: true, force: true });
    env.cleanup();
  });

  const token = () => mintToken(secret, { sub: String(OWNER_ID), uid: OWNER_ID });

  async function boot(relayUrls?: () => { kind: 'funnel' | 'ngrok'; url: string }[]) {
    ({ app } = await buildServer(loadConfig(), {
      jwtSecret: secret,
      webDist,
      relayUrls,
    }));
    await app.ready();
    return app;
  }

  it('401s /api/relays without a token', async () => {
    await boot(() => [{ kind: 'funnel', url: 'https://mac.example.ts.net' }]);
    const res = await app!.inject({ method: 'GET', url: '/api/relays' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the ordered relay urls to an authenticated caller', async () => {
    await boot(() => [
      { kind: 'funnel', url: 'https://mac.example.ts.net' },
      { kind: 'ngrok', url: 'https://aside-mac.ngrok-free.dev' },
    ]);
    const res = await app!.inject({
      method: 'GET',
      url: '/api/relays',
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      relays: [
        { kind: 'funnel', url: 'https://mac.example.ts.net' },
        { kind: 'ngrok', url: 'https://aside-mac.ngrok-free.dev' },
      ],
    });
  });

  it('drops non-https relay urls from /api/relays', async () => {
    await boot(() => [
      { kind: 'funnel', url: 'javascript:alert(1)' },
      { kind: 'ngrok', url: 'https://aside-mac.ngrok-free.dev' },
    ]);
    const res = await app!.inject({
      method: 'GET',
      url: '/api/relays',
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.json()).toEqual({
      relays: [{ kind: 'ngrok', url: 'https://aside-mac.ngrok-free.dev' }],
    });
  });

  it('names the exact relay origins in connect-src, and nothing broader', async () => {
    await boot(() => [
      { kind: 'funnel', url: 'https://mac.example.ts.net' },
      { kind: 'ngrok', url: 'https://aside-mac.ngrok-free.dev' },
    ]);
    const res = await app!.inject({ method: 'GET', url: '/api/health' });
    const csp = String(res.headers['content-security-policy'] || '');
    expect(csp).toContain('https://mac.example.ts.net');
    expect(csp).toContain('https://aside-mac.ngrok-free.dev');
    const connect = /connect-src[^;]*/.exec(csp)?.[0] ?? '';
    expect(connect).not.toContain('*');
  });

  it('leaves connect-src untouched when no relays are configured', async () => {
    await boot();
    const res = await app!.inject({ method: 'GET', url: '/api/health' });
    const csp = String(res.headers['content-security-policy'] || '');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('ngrok');
  });

  it('bakes the failover list into the standalone shell as a meta tag', async () => {
    await boot(() => [
      { kind: 'funnel', url: 'https://mac.example.ts.net' },
      { kind: 'ngrok', url: 'https://aside-mac.ngrok-free.dev' },
    ]);
    const res = await app!.inject({ method: 'GET', url: '/app' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      '<meta name="aside-relays" content="https://mac.example.ts.net https://aside-mac.ngrok-free.dev" />',
    );
  });

  it('omits the meta tag when no relay has verified', async () => {
    await boot(() => []);
    const res = await app!.inject({ method: 'GET', url: '/app' });
    expect(res.body).not.toContain('aside-relays');
  });

  it('reads the relay list per request, not once into the cached shell', async () => {
    const urls: { kind: 'funnel' | 'ngrok'; url: string }[] = [];
    await boot(() => urls);
    const before = await app!.inject({ method: 'GET', url: '/app' });
    expect(before.body).not.toContain('aside-relays');
    urls.push({ kind: 'funnel', url: 'https://mac.example.ts.net' });
    const after = await app!.inject({ method: 'GET', url: '/app' });
    expect(after.body).toContain('content="https://mac.example.ts.net"');
  });
});
