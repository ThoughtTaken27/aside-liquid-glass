/**
 * Response headers.
 *
 * Two things are being guarded here. The obvious one is that the headers
 * are present at all. The subtle one is precedence: the artifact and
 * local-file routes serve bytes this server did not author, under a much
 * stricter `sandbox; default-src 'none'` policy, and the blanket hook that
 * adds the app's own CSP must never overwrite it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { PairingCodeStore } from '../src/pair.js';
import { FIXTURE_SESSIONS, makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: FastifyInstance;
let webDist: string;
let secret: string;
let token: string;

beforeEach(async () => {
  env = makeTestEnv();
  webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'hdr-dist-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html>ok');
  const config = loadConfig();
  secret = loadOrCreateJwtSecret(config.secretPath);
  const pairingCodes = new PairingCodeStore();
  ({ app } = await buildServer(config, { jwtSecret: secret, webDist, pairingCodes }));
  await app.ready();
  const paired = await app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { key: pairingCodes.issue() },
  });
  token = paired.json().token as string;
});

afterEach(async () => {
  await app.close();
  fs.rmSync(webDist, { recursive: true, force: true });
  env.cleanup();
});

describe('every response', () => {
  it('carries nosniff, no-referrer and HSTS', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('carries a CSP that allows what the app actually needs', async () => {
    const res = await app.inject({ method: 'GET', url: '/app' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    // This harness has Telegram configured, so its root entry may load the
    // one bridge origin. Standalone mode is asserted separately.
    expect(csp).toContain("script-src 'self' https://telegram.org");
    // Shiki emits inline styles for syntax colours; React sets style attrs.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // Screenshots arrive as blobs, transcript images as data URIs.
    expect(csp).toContain('img-src');
    expect(csp).toContain('blob:');
    // Some browsers do not map CSP 'self' across the HTTP/WebSocket scheme
    // boundary, so the exact request host is named without allowing others.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain('ws://localhost');
    expect(csp).toContain('wss://localhost');
    expect(csp).not.toContain(' ws: ');
    expect(csp).not.toContain(' wss: ');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it('does not reflect an unsafe Host value into socket sources', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/app',
      headers: { host: 'good.example; wss://evil.example' },
    });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).not.toContain('evil.example');
    expect(csp).toContain("connect-src 'self'");
  });

  it('allows Telegram to frame it, but only in Telegram mode', async () => {
    // This harness configures a bot token, which is the mode where the app
    // legitimately runs inside an iframe on web.telegram.org. The
    // standalone half of this rule is asserted in standalone-mode.test.ts,
    // where a blanket 'none' is the correct answer.
    expect(loadConfig().standalone).toBe(false);
    const res = await app.inject({ method: 'GET', url: '/app' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain('https://web.telegram.org');
    expect(csp).not.toContain("frame-ancestors 'none'");
  });
});

describe('routes that serve foreign bytes', () => {
  it('keep their own sandbox CSP instead of the app one', async () => {
    const sessionDir = fs
      .readdirSync(FIXTURE_SESSIONS)
      .find((d) => d.includes('fixtureDDDD'));
    expect(sessionDir).toBeTruthy();

    const res = await app.inject({
      method: 'GET',
      url:
        '/api/sessions/fixtureDDDD/artifacts/file' +
        '?group=artifacts&path=2026-01-06%2Fnotes.md',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain('sandbox');
    expect(csp).toContain("default-src 'none'");
    // The looser app policy must not have leaked onto this response.
    expect(csp).not.toContain('telegram.org');
    expect(csp).not.toContain("'unsafe-inline'");
    // The shared headers still apply.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
