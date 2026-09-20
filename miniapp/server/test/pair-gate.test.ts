/**
 * The pairing page must not be reachable through the proxied port.
 *
 * The bug these guard: `/pair` lived on the main app behind a
 * `request.ip === '127.0.0.1'` check. `tailscale serve` terminates TLS and
 * proxies to loopback, and `trustProxy` is off, so every tailnet request
 * presented as loopback and the check passed for everyone. Fetching
 * `https://<tailnet-host>/pair` returned the QR byte-for-byte identical to
 * the loopback response.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { PairingCodeStore, buildPairServer } from '../src/pair.js';

function pairServer(appPort = 8790): { pairApp: import('fastify').FastifyInstance; codes: PairingCodeStore } {
  const codes = new PairingCodeStore();
  const pairApp = buildPairServer({
    issuePairingCode: () => codes.issue(),
    appPort,
    tailnetHost: () => 'mac.example.ts.net',
  });
  return { pairApp, codes };
}
import { makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: FastifyInstance;
let webDist: string;
let secret: string;

beforeEach(async () => {
  env = makeTestEnv();
  const config = loadConfig();
  secret = loadOrCreateJwtSecret(config.secretPath);
  // `/pair` is only registered when a built SPA is present, so the pointer
  // page needs one to exist at all.
  webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-dist-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html>ok');
  ({ app } = await buildServer(config, { jwtSecret: secret, webDist }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(webDist, { recursive: true, force: true });
  env.cleanup();
});

describe('the proxied port never serves the pairing page', () => {
  it('refuses /pair even when the request presents as loopback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pair',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(403);
    // The QR is the credential. It must not be in the body at any IP.
    expect(res.body).not.toContain('data:image/png;base64');
    expect(res.body).not.toContain('#pair=');
  });

  it('refuses /pair for a request that arrived over the tailnet', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pair',
      remoteAddress: '100.96.251.107',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('#pair=');
  });

  it('points at the separate loopback port', async () => {
    const res = await app.inject({ method: 'GET', url: '/pair' });
    expect(res.body).toContain('127.0.0.1:8791/pair');
  });
});

describe('the pairing listener', () => {
  it('serves the QR to loopback', async () => {
    const { pairApp } = pairServer();
    await pairApp.ready();
    const res = await pairApp.inject({
      method: 'GET',
      url: '/pair',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data:image/png;base64');
    await pairApp.close();
  });


  it('issues no code when the tailnet hostname is unavailable', async () => {
    let issued = 0;
    const pairApp = buildPairServer({
      issuePairingCode: () => { issued += 1; return 'code'; },
      appPort: 8790,
      tailnetHost: () => null,
    });
    await pairApp.ready();
    const res = await pairApp.inject({ method: 'GET', url: '/pair', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('Tailscale is not ready');
    expect(res.body).not.toContain('#pair=');
    expect(issued).toBe(0);
    await pairApp.close();
  });

  it('still refuses a non-loopback peer, in case someone proxies this port too', async () => {
    const { pairApp } = pairServer();
    await pairApp.ready();
    const res = await pairApp.inject({
      method: 'GET',
      url: '/pair',
      remoteAddress: '100.96.251.107',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('data:image/png;base64');
    await pairApp.close();
  });

  /*
   * The page used to render the QR and nothing else, while the README told
   * iPhone owners to "copy the pairing link from the pairing page". There
   * was no link to copy: it existed only as pixels inside a PNG. iOS is the
   * platform that cannot pair by scanning, because an installed web app has
   * storage separate from the Safari tab it was installed from, so paste is
   * the only route it has. That made the documented iPhone install
   * impossible to finish.
   */
  it('renders the pairing link as selectable text, not only as a QR', async () => {
    const { pairApp } = pairServer();
    await pairApp.ready();
    const res = await pairApp.inject({
      method: 'GET',
      url: '/pair',
      remoteAddress: '127.0.0.1',
    });
    const match = /value="([^"]*#pair=[^"]+)"/.exec(res.body);
    expect(match?.[1]).toMatch(/^https:\/\/mac\.example\.ts\.net\/app#pair=[A-Za-z0-9_-]+$/);
    await pairApp.close();
  });

  it('tells iPhone owners to install before pairing, and Android after', async () => {
    const { pairApp } = pairServer();
    await pairApp.ready();
    const res = await pairApp.inject({
      method: 'GET',
      url: '/pair',
      remoteAddress: '127.0.0.1',
    });
    expect(res.body).toContain('<h2>iPhone</h2>');
    expect(res.body).toContain('<h2>Android</h2>');
    // The ordering rule is the whole point of the iPhone section.
    expect(res.body).toMatch(/Add to Home Screen/i);
    expect(res.body).toMatch(/not<\/b> scan the code yet/i);
    await pairApp.close();
  });

  it('keeps the link out of the 403 body, where the QR was already absent', async () => {
    const { pairApp } = pairServer();
    await pairApp.ready();
    const res = await pairApp.inject({
      method: 'GET',
      url: '/pair',
      remoteAddress: '100.96.251.107',
    });
    expect(res.statusCode).toBe(403);
    // Adding the link as text created a second way to leak it.
    expect(res.body).not.toContain('#pair=');
    await pairApp.close();
  });

  it('issues one-time codes that spend exactly once', () => {
    const codes = new PairingCodeStore();
    const first = codes.issue();
    expect(codes.consume(first)).toBe(true);
    expect(codes.consume(first)).toBe(false);
  });

  it('expires codes after ten minutes', () => {
    const codes = new PairingCodeStore();
    const code = codes.issue(0);
    expect(codes.consume(code, 10 * 60 * 1000 + 1)).toBe(false);
  });

  it('spends a pairing-page code against the app exactly once', async () => {
    const codes = new PairingCodeStore();
    const { app: spendApp } = await buildServer(loadConfig(), {
      jwtSecret: secret,
      webDist,
      pairingCodes: codes,
    });
    await spendApp.ready();
    try {
      const issuer = buildPairServer({
        issuePairingCode: () => codes.issue(),
        appPort: 8790,
        tailnetHost: () => 'mac.example.ts.net',
      });
      await issuer.ready();
      const page = await issuer.inject({ method: 'GET', url: '/pair', remoteAddress: '127.0.0.1' });
      await issuer.close();
      const code = /#pair=([A-Za-z0-9_-]+)/.exec(page.body)?.[1];
      expect(code).toBeTruthy();
      const first = await spendApp.inject({ method: 'POST', url: '/api/pair', payload: { key: code } });
      expect(first.statusCode).toBe(200);
      const replay = await spendApp.inject({ method: 'POST', url: '/api/pair', payload: { key: code } });
      expect(replay.statusCode).toBe(401);
    } finally {
      await spendApp.close();
    }
  });
});
