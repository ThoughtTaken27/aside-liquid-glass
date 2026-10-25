/**
 * Hey Aside security: the parts that must hold even if every model is fooled.
 * Attestation, signed requests, fingerprint tickets, limits, duress, audit.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttestationError, verifyAttestation, type VerifyOptions } from '../src/voice/attestation.js';
import { AuditLog, verifyAuditChain } from '../src/voice/audit.js';
import { ActionLimiter, VoicePairCodes, voiceRoutes, validPhoneAction, PublicSpeechTokens } from '../src/voice/routes.js';
import { NonceCache, canonical, sha256Hex, ticketString, verifySignedRequest } from '../src/voice/signing.js';
import { keyDescription, makeChain, makeRoot, type TestPki } from './voice-fixtures.js';

const SIGNER = 'cd'.repeat(32);
let pki: TestPki;

beforeAll(() => {
  pki = makeRoot();
});
afterAll(() => fs.rmSync(pki.dir, { recursive: true, force: true }));

function base(challenge: Buffer, role: 'request' | 'action'): VerifyOptions {
  return { challenge, role, expectedPackage: 'app.aside.mobile', expectedSigningDigest: SIGNER, rootSpkiSha256: [pki.rootSpkiSha256], revokedSerials: new Set<string>() };
}

describe('hardware attestation', () => {
  const ch = crypto.randomBytes(32);
  const good = (role: 'request' | 'action', over: Record<string, unknown> = {}) =>
    makeChain(pki, keyDescription({ challenge: ch, role, signerDigestHex: SIGNER, ...over }));

  it('accepts a correct request key and a correct action key', () => {
    const r = good('request');
    expect(verifyAttestation(r.chain, Buffer.from(r.spkiB64, 'base64'), base(ch, 'request')).securityLevel).toBe('tee');
    const a = good('action', { level: 2 });
    expect(verifyAttestation(a.chain, Buffer.from(a.spkiB64, 'base64'), base(ch, 'action')).securityLevel).toBe('strongbox');
  });

  const reject = (role: 'request' | 'action', over: Record<string, unknown>, code: string, opts: Record<string, unknown> = {}) => {
    const c = good(role, over);
    try {
      verifyAttestation(c.chain, Buffer.from(c.spkiB64, 'base64'), { ...base(ch, role), ...opts });
      throw new Error('accepted');
    } catch (err) {
      expect(err).toBeInstanceOf(AttestationError);
      expect((err as AttestationError).code).toBe(code);
    }
  };

  it('rejects expired and not-yet-valid attestation certificates', () => {
    const c = good('request');
    for (const now of [Date.now() - 86_400_000, Date.now() + 31 * 86_400_000]) {
      expect(() => verifyAttestation(c.chain, Buffer.from(c.spkiB64, 'base64'), { ...base(ch, 'request'), now })).toThrow(/certificate_time_invalid/);
    }
  });
  it('rejects a software key', () => reject('request', { level: 0 }, 'software_key'));
  it('rejects a software key with a hardware attestation wrapper', () => reject('request', { keyLevel: 0 }, 'software_key'));
  it('rejects PIN fallback in an action key', () => reject('action', { userAuthType: 3 }, 'action_key_not_biometric'));
  it('rejects a replayed chain (wrong challenge)', () => reject('request', { challenge: crypto.randomBytes(32) }, 'challenge_mismatch'));
  it('rejects an unlocked bootloader', () => reject('request', { deviceLocked: false }, 'bootloader_unlocked'));
  it('rejects unverified boot', () => reject('request', { bootState: 2 }, 'boot_not_verified'));
  it('rejects another app', () => reject('request', { pkg: 'com.evil.app' }, 'wrong_package'));
  it('rejects another signer', () => reject('request', { signerDigestHex: 'ee'.repeat(32) }, 'wrong_signer'));
  it('rejects a request key usable while locked', () => reject('request', { unlockedRequired: false }, 'request_key_works_while_locked'));
  it('rejects an action key without auth', () => reject('action', { noAuthRequired: true }, 'action_key_without_auth'));
  it('rejects an action key without biometric', () => reject('action', { userAuthType: 1 }, 'action_key_not_biometric'));
  it('rejects an action key with an auth window', () => reject('action', { authTimeout: 300 }, 'action_key_has_timeout'));
  it('rejects an unknown root (e.g. self-made)', () => reject('request', {}, 'unknown_root', { rootSpkiSha256: ['00'.repeat(32)] }));
  it('rejects when no signer is configured', () => reject('request', {}, 'signing_digest_not_configured', { expectedSigningDigest: '' }));

  it('rejects a revoked certificate', () => {
    const c = good('request');
    expect(() =>
      verifyAttestation(c.chain, Buffer.from(c.spkiB64, 'base64'), { ...base(ch, 'request'), revokedSerials: new Set([c.serial]) }),
    ).toThrow(/revoked/);
  });

  it('rejects a chain for a different key', () => {
    const c = good('request');
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = Buffer.from(other.publicKey.export({ type: 'spki', format: 'der' }));
    expect(() => verifyAttestation(c.chain, spki, base(ch, 'request'))).toThrow(/key_mismatch/);
  });

  it('rejects a chain whose leaf was not signed by the root', () => {
    const c = good('request');
    const other = makeRoot();
    expect(() => verifyAttestation([c.chain[0], fs.readFileSync(other.rootCert, 'utf8')], Buffer.from(c.spkiB64, 'base64'), { ...base(ch, 'request'), rootSpkiSha256: [other.rootSpkiSha256] })).toThrow(expect.objectContaining({ code: 'broken_chain' }));
    fs.rmSync(other.dir, { recursive: true, force: true });
  });
});

describe('audit log', () => {
  it('detects tampering', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-audit-'));
    const log = new AuditLog(dir);
    for (let i = 0; i < 5; i++) log.write({ kind: 'turn.quick', ok: true, detail: `n${i}` });
    const lines = fs.readFileSync(log.file, 'utf8').trimEnd().split('\n');
    expect(verifyAuditChain(lines)).toBe(-1);
    lines[2] = lines[2].replace('n2', 'n9');
    expect(verifyAuditChain(lines)).toBe(2);
    const dropped = fs.readFileSync(log.file, 'utf8').trimEnd().split('\n');
    dropped.splice(1, 1);
    expect(verifyAuditChain(dropped)).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('pairing codes and limits', () => {
  it('a code works once', () => {
    const c = new VoicePairCodes();
    const code = c.issue();
    expect(code).toMatch(/^\d{8}$/);
    expect(c.consume(code)).toBe(true);
    expect(c.consume(code)).toBe(false);
  });
  it('three wrong tries kill the code', () => {
    const c = new VoicePairCodes();
    const code = c.issue();
    const wrong = code === '00000000' ? '11111111' : '00000000';
    c.consume(wrong);
    c.consume(wrong);
    c.consume(wrong);
    expect(c.consume(code)).toBe(false);
  });
  it('codes expire after 5 minutes', () => {
    const c = new VoicePairCodes();
    const code = c.issue(0);
    expect(c.consume(code, 5 * 60_000 + 1)).toBe(false);
  });
  it('Tier C is capped at 5 per 10 minutes', () => {
    const l = new ActionLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(l.allow(t + i)).toBe(true);
    expect(l.allow(t + 10)).toBe(false);
    expect(l.allow(t + 601_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End to end through the routes.

function signer(deviceId: string, key: crypto.KeyObject) {
  return (method: string, url: string, body: string, over: Partial<Record<string, string>> = {}) => {
    const ts = over.ts ?? String(Date.now());
    const nonce = over.nonce ?? crypto.randomBytes(18).toString('base64url');
    const msg = canonical(method, url, deviceId, ts, nonce, sha256Hex(Buffer.from(body)));
    const sig = crypto.sign('sha256', Buffer.from(msg), { key, dsaEncoding: 'der' }).toString('base64');
    return { 'x-aside-device': deviceId, 'x-aside-ts': ts, 'x-aside-nonce': nonce, 'x-aside-sig': over.sig ?? sig, 'content-type': 'application/json' };
  };
}

function ticket(deviceId: string, key: crypto.KeyObject, action: Record<string, unknown>) {
  const t = { action: JSON.stringify(action), ts: String(Date.now()), nonce: crypto.randomBytes(18).toString('base64url') };
  return { ...t, sig: crypto.sign('sha256', Buffer.from(ticketString(deviceId, t)), { key, dsaEncoding: 'der' }).toString('base64') };
}

describe('voice routes', () => {
  let app: ReturnType<typeof Fastify>;
  let stateDir: string;
  const codes = new VoicePairCodes();
  let deviceId = '';
  let reqKeys: crypto.KeyPairKeyObjectResult;
  let actKeys: crypto.KeyPairKeyObjectResult;
  const alerts: string[] = [];

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-state-'));
    fs.writeFileSync(path.join(stateDir, 'voice-config.json'), JSON.stringify({ signingCertSha256: SIGNER }));
    app = Fastify();
    await app.register(voiceRoutes, {
      stateDir,
      pairCodes: codes,
      complete: () => null,
      brain: {
        route: async () => ({ route: 'chat' as const }),
        quick: async (t: string) => `Answer to ${t}.`,
        complete: () => null,
        plan: async () => null,
      },
      alert: (_t: string, b: string) => alerts.push(b),
      revokedSerials: async () => new Set(),
      rootSpkiSha256: [pki.rootSpkiSha256],
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('refuses pairing without the Mac-issued code', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/voice/pair/start', payload: { code: '12345678' } });
    expect(r.statusCode).toBe(401);
  });

  it('pairs with a code plus valid attestation for both keys', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/voice/pair/start', payload: { code: codes.issue() } });
    expect(start.statusCode).toBe(200);
    const { pairId, challenge } = start.json();
    const ch = Buffer.from(challenge, 'base64');
    const r = makeChain(pki, keyDescription({ challenge: ch, role: 'request', signerDigestHex: SIGNER }));
    const a = makeChain(pki, keyDescription({ challenge: ch, role: 'action', signerDigestHex: SIGNER }));
    reqKeys = r.keys;
    actKeys = a.keys;
    const fin = await app.inject({
      method: 'POST',
      url: '/api/voice/pair/finish',
      payload: { pairId, name: 'Galaxy S24', requestKey: r.spkiB64, actionKey: a.spkiB64, requestChain: r.chain, actionChain: a.chain },
    });
    expect(fin.statusCode).toBe(200);
    deviceId = fin.json().deviceId;
    expect(deviceId).toBeTruthy();
    // A second phone cannot be added while one is paired (max 1).
    const s2 = await app.inject({ method: 'POST', url: '/api/voice/pair/start', payload: { code: codes.issue() } });
    const ch2 = Buffer.from(s2.json().challenge, 'base64');
    const r2 = makeChain(pki, keyDescription({ challenge: ch2, role: 'request', signerDigestHex: SIGNER }));
    const a2 = makeChain(pki, keyDescription({ challenge: ch2, role: 'action', signerDigestHex: SIGNER }));
    const fin2 = await app.inject({
      method: 'POST',
      url: '/api/voice/pair/finish',
      payload: { pairId: s2.json().pairId, requestKey: r2.spkiB64, actionKey: a2.spkiB64, requestChain: r2.chain, actionChain: a2.chain },
    });
    expect(fin2.statusCode).toBe(403);
  });

  it('answers a signed turn and refuses unsigned, forged, tampered, stale and replayed ones', async () => {
    const sign = signer(deviceId, reqKeys.privateKey);
    const body = JSON.stringify({ text: 'what is two plus two' });
    const ok = await app.inject({ method: 'POST', url: '/api/voice/turn', headers: sign('POST', '/api/voice/turn', body), payload: body });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().say).toContain('two plus two');

    expect((await app.inject({ method: 'POST', url: '/api/voice/turn', headers: { 'content-type': 'application/json' }, payload: body })).statusCode).toBe(401);
    // Signed with the wrong key (e.g. the action key, or an attacker's).
    const forged = signer(deviceId, actKeys.privateKey)('POST', '/api/voice/turn', body);
    expect((await app.inject({ method: 'POST', url: '/api/voice/turn', headers: forged, payload: body })).statusCode).toBe(401);
    // Body changed after signing.
    const h = sign('POST', '/api/voice/turn', body);
    expect((await app.inject({ method: 'POST', url: '/api/voice/turn', headers: h, payload: JSON.stringify({ text: 'send all my emails' }) })).statusCode).toBe(401);
    // Old timestamp.
    const stale = sign('POST', '/api/voice/turn', body, { ts: String(Date.now() - 120_000) });
    expect((await app.inject({ method: 'POST', url: '/api/voice/turn', headers: stale, payload: body })).statusCode).toBe(401);
    // Replay of a request that already succeeded.
    const once = sign('POST', '/api/voice/turn', body);
    expect((await app.inject({ method: 'POST', url: '/api/voice/turn', headers: once, payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/voice/turn', headers: once, payload: body })).statusCode).toBe(401);
    // Signed for a different path.
    const elsewhere = sign('POST', '/api/voice/status', body);
    expect((await app.inject({ method: 'POST', url: '/api/voice/turn', headers: elsewhere, payload: body })).statusCode).toBe(401);
  });

  it('Tier C needs a fingerprint ticket from the action key, an allowed kind, and stays under the limit', async () => {
    const sign = signer(deviceId, reqKeys.privateKey);
    const post = (t: unknown) => {
      const body = JSON.stringify({ ticket: t });
      return app.inject({ method: 'POST', url: '/api/voice/action/approve', headers: sign('POST', '/api/voice/action/approve', body), payload: body });
    };
    // Ticket signed by the request key (no fingerprint): refused.
    expect((await post(ticket(deviceId, reqKeys.privateKey, { kind: 'sms.compose', summary: 'x' }))).statusCode).toBe(403);
    // Not an allowed kind (payments, settings...): refused even with a fingerprint.
    expect((await post(ticket(deviceId, actKeys.privateKey, { kind: 'payment.send' }))).statusCode).toBe(403);
    // Valid, then replay of the same ticket refused.
    const t = ticket(deviceId, actKeys.privateKey, { kind: 'sms.compose', target: '+15555550123', text: 'Running late.' });
    expect((await post(t)).statusCode).toBe(200);
    expect((await post(t)).statusCode).toBe(403);
    // Four more allowed, the sixth in ten minutes refused.
    for (let i = 0; i < 4; i++) expect((await post(ticket(deviceId, actKeys.privateKey, { kind: 'call.dial', target: '+15555550123', text: 'Open dialer only.' }))).statusCode).toBe(200);
    expect((await post(ticket(deviceId, actKeys.privateKey, { kind: 'call.dial', target: '+15555550123', text: 'Open dialer only.' }))).statusCode).toBe(429);
  });

  it('rejects arbitrary speech text; every server-written reply gets a single-use token bound to that text', async () => {
    const sign = signer(deviceId, reqKeys.privateKey);
    const post = (url: string, value: unknown) => { const body = JSON.stringify(value); return app.inject({ method: 'POST', url, headers: sign('POST', url, body), payload: body }); };
    expect((await post('/api/voice/tts', { text: 'private text' })).statusCode).toBe(403);
    // Ryan for all replies (Owner's choice, Oct 5): private and follow-up turns get a token too, but a token
    // only ever speaks the server's own reply text, never caller-supplied text.
    const privateTurn = await post('/api/voice/turn', { text: 'what is my school plan' });
    expect(privateTurn.json().private).toBe(true);
    expect(typeof privateTurn.json().speechToken).toBe('string');
    const followUp = await post('/api/voice/turn', { text: 'tell me more', history: [{ q: 'private q', a: 'private a' }] });
    expect(typeof followUp.json().speechToken).toBe('string');
    expect((await post('/api/voice/tts', { token: 'not-a-real-token' })).statusCode).toBe(403);
    // Phone-written phrases are short plain text only; anything else still needs a server token.
    expect((await post('/api/voice/tts', { phrase: 'see https://evil.example/<script>' })).statusCode).toBe(403);
    expect((await post('/api/voice/tts', { phrase: 'a'.repeat(201) })).statusCode).toBe(403);
  });
  it('phone audit is per-device and redacted', async () => {
    // Existing auth failures have no calling device and must not be returned.
    const sign = signer(deviceId, reqKeys.privateKey);
    const r = await app.inject({ method: 'GET', url: '/api/voice/audit', headers: sign('GET', '/api/voice/audit', '') });
    expect(r.statusCode).toBe(200); expect(r.body).not.toContain('OTHER_PRIVATE');
    expect(r.json().entries.every((e: object) => !('detail' in e))).toBe(true);
  });
  it('the duress phrase revokes the phone at once', async () => {
    const sign = signer(deviceId, reqKeys.privateKey);
    const d = await app.inject({ method: 'POST', url: '/api/voice/duress', headers: sign('POST', '/api/voice/duress', ''), payload: '' });
    expect(d.statusCode).toBe(200);
    const body = JSON.stringify({ text: 'hello' });
    const after = await app.inject({ method: 'POST', url: '/api/voice/turn', headers: sign('POST', '/api/voice/turn', body), payload: body });
    expect(after.statusCode).toBe(401);
    expect(alerts.some((a) => /duress/i.test(a))).toBe(true);
    const lines = fs.readFileSync(path.join(stateDir, 'voice-audit.jsonl'), 'utf8').trimEnd().split('\n');
    expect(verifyAuditChain(lines)).toBe(-1);
  });
});

describe('signature unit', () => {
  it('rejects a revoked device even with a perfect signature', () => {
    const k = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ts = String(Date.now());
    const nonce = crypto.randomBytes(18).toString('base64url');
    const msg = canonical('GET', '/api/voice/status', 'dev12345', ts, nonce, sha256Hex(''));
    const sig = crypto.sign('sha256', Buffer.from(msg), { key: k.privateKey, dsaEncoding: 'der' }).toString('base64');
    const headers = { 'x-aside-device': 'dev12345', 'x-aside-ts': ts, 'x-aside-nonce': nonce, 'x-aside-sig': sig };
    expect(() => verifySignedRequest({ method: 'GET', url: '/api/voice/status', headers, rawBody: Buffer.alloc(0) }, { active: () => null }, new NonceCache())).toThrow(/unknown_device/);
  });
});

describe('strict phone action boundary', () => {
  it('permits only exact draft/dial schemas, never autonomous commits', () => {
    expect(validPhoneAction({ kind: 'sms.compose', target: '+15555550123', text: 'Hello.' })).toBe(true);
    for (const kind of ['sms.send', 'screen.commit', 'notification.reply', 'payment.send', 'calendar.add']) expect(validPhoneAction({ kind, target: '+15555550123', text: 'Hello.' })).toBe(false);
    expect(validPhoneAction({ kind: 'call.dial', target: 'tel:secret', text: 'x' })).toBe(false);
    expect(validPhoneAction({ kind: 'sms.compose', target: '+15555550123', text: 'x', extra: 'hidden' })).toBe(false);
    expect(validPhoneAction({ kind: 'sms.compose', target: '+15555550123', text: '\u202espoofed' })).toBe(false);
  });
});
describe('public speech capability', () => {
  it('is exact, single-use, expires and cannot cross devices', () => {
    const tokens = new PublicSpeechTokens(); const id = tokens.issue('phone1', 'Exact public reply.', 1000);
    expect(tokens.consume('phone2', id, 1001)).toBeNull();
    expect(tokens.consume('phone1', id, 1001)).toBe('Exact public reply.');
    expect(tokens.consume('phone1', id, 1002)).toBeNull();
    const expired = tokens.issue('phone1', 'A.', 1000); expect(tokens.consume('phone1', expired, 61000)).toBeNull();
  });
});

describe('restart persistence', () => {
  it('keeps nonces and action limits across new instances', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-persist-'));
    try {
      const file = path.join(dir, 'nonces.json');
      expect(new NonceCache(120000, file).claim('nonce1', 1000)).toBe(true);
      expect(new NonceCache(120000, file).claim('nonce1', 1001)).toBe(false);
      const limits = path.join(dir, 'limits.json');
      expect(new ActionLimiter(1, 30, limits).allow(1000)).toBe(true);
      expect(new ActionLimiter(1, 30, limits).allow(1001)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('voice routes: full Aside tasks', () => {
  let app: ReturnType<typeof Fastify>;
  let stateDir: string;
  const codes = new VoicePairCodes();
  let deviceId = '';
  let reqKeys: crypto.KeyPairKeyObjectResult;
  let actKeys: crypto.KeyPairKeyObjectResult;
  const started: Array<{ kind: string; request: string }> = [];
  const agent = {
    limits: () => 'Locked limits.',
    readyIn: () => 0,
    start: async (kind: 'research' | 'act', request: string) => { started.push({ kind, request }); return { taskId: 'a'.repeat(24) }; },
    status: (id: string) => (id === 'a'.repeat(24) ? { state: 'done' as const, step: null, say: 'Found it.', detail: 'More.', denied: 0 } : null),
    stop: () => true,
  };
  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-agent-'));
    fs.writeFileSync(path.join(stateDir, 'voice-config.json'), JSON.stringify({ signingCertSha256: SIGNER }));
    app = Fastify();
    await app.register(voiceRoutes, {
      stateDir, pairCodes: codes, complete: () => null, agent,
      brain: { route: async () => ({ route: 'chat' as const }), quick: async (t: string) => `Answer to ${t}.`, complete: () => null, plan: async () => null },
      alert: () => undefined, revokedSerials: async () => new Set(), rootSpkiSha256: [pki.rootSpkiSha256],
    });
    await app.ready();
    const start = await app.inject({ method: 'POST', url: '/api/voice/pair/start', payload: { code: codes.issue() } });
    const { pairId, challenge } = start.json();
    const ch = Buffer.from(challenge, 'base64');
    const r = makeChain(pki, keyDescription({ challenge: ch, role: 'request', signerDigestHex: SIGNER }));
    const a = makeChain(pki, keyDescription({ challenge: ch, role: 'action', signerDigestHex: SIGNER }));
    reqKeys = r.keys; actKeys = a.keys;
    const fin = await app.inject({ method: 'POST', url: '/api/voice/pair/finish', payload: { pairId, name: 'Galaxy S24', requestKey: r.spkiB64, actionKey: a.spkiB64, requestChain: r.chain, actionChain: a.chain } });
    deviceId = fin.json().deviceId;
  });
  afterAll(async () => { await app.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const post = (url: string, value: unknown) => { const body = JSON.stringify(value); return app.inject({ method: 'POST', url, headers: signer(deviceId, reqKeys.privateKey)('POST', url, body), payload: body }); };

  it('research starts right away in a locked session and can be polled', async () => {
    const r = (await post('/api/voice/turn', { text: 'research the best laptops for college' })).json();
    expect(r.lane).toBe('task'); expect(r.taskId).toBe('a'.repeat(24));
    expect(started.at(-1)).toEqual({ kind: 'research', request: 'research the best laptops for college' });
    const url = `/api/voice/task/${'a'.repeat(24)}`;
    const st = await app.inject({ method: 'GET', url, headers: signer(deviceId, reqKeys.privateKey)('GET', url, '') });
    expect(st.json()).toMatchObject({ state: 'done', say: 'Found it.' }); expect(typeof st.json().speechToken).toBe('string');
  });
  it('a "do it for me" request never starts without a fingerprint-signed ticket', async () => {
    const before = started.length;
    const r = (await post('/api/voice/turn', { text: 'book a table at Olive Garden for 7' })).json();
    expect(r.lane).toBe('approve'); expect(r.approval).toMatchObject({ kind: 'agent.task', target: 'mac', text: 'book a table at Olive Garden for 7' });
    expect(started.length).toBe(before);
    // Signed by the request key (no fingerprint): refused, nothing started.
    expect((await post('/api/voice/action/approve', { ticket: ticket(deviceId, reqKeys.privateKey, { kind: 'agent.task', target: 'mac', text: 'book a table' }) })).statusCode).toBe(403);
    // Wrong target or extra fields: refused.
    expect((await post('/api/voice/action/approve', { ticket: ticket(deviceId, actKeys.privateKey, { kind: 'agent.task', target: 'phone', text: 'book a table' }) })).statusCode).toBe(403);
    expect(started.length).toBe(before);
    // Fingerprint-signed for the exact text: starts that text, once.
    const t = ticket(deviceId, actKeys.privateKey, { kind: 'agent.task', target: 'mac', text: 'book a table at Olive Garden for 7' });
    const ok = await post('/api/voice/action/approve', { ticket: t });
    expect(ok.statusCode).toBe(200); expect(ok.json().taskId).toBe('a'.repeat(24));
    expect(started.at(-1)).toEqual({ kind: 'act', request: 'book a table at Olive Garden for 7' });
    expect((await post('/api/voice/action/approve', { ticket: t })).statusCode).toBe(403);
  });
  it('unknown task ids are not found', async () => {
    const url = `/api/voice/task/${'b'.repeat(24)}`;
    expect((await app.inject({ method: 'GET', url, headers: signer(deviceId, reqKeys.privateKey)('GET', url, '') })).statusCode).toBe(404);
  });
});

describe('voice routes: phone control phase 1 gate', () => {
  let app: ReturnType<typeof Fastify>;
  let stateDir: string;
  const codes = new VoicePairCodes();
  let deviceId = '';
  let reqKeys: crypto.KeyPairKeyObjectResult;
  let on = false;
  let modelReply: () => Promise<string> = async () => '{"type":"tap","i":1,"why":"open tab"}';
  let modelCalls = 0;
  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-screen-'));
    fs.writeFileSync(path.join(stateDir, 'voice-config.json'), JSON.stringify({ signingCertSha256: SIGNER }));
    app = Fastify();
    await app.register(voiceRoutes, {
      stateDir, pairCodes: codes, complete: () => async () => '{"type":"tap","i":1}',
      screenComplete: () => async () => { modelCalls++; return modelReply(); },
      screenControl: () => on,
      brain: { route: async () => ({ route: 'chat' as const }), quick: async (t: string) => `Answer to ${t}.`, complete: () => null, plan: async () => null },
      alert: () => undefined, revokedSerials: async () => new Set(), rootSpkiSha256: [pki.rootSpkiSha256],
    });
    await app.ready();
    const start = await app.inject({ method: 'POST', url: '/api/voice/pair/start', payload: { code: codes.issue() } });
    const { pairId, challenge } = start.json();
    const ch = Buffer.from(challenge, 'base64');
    const r = makeChain(pki, keyDescription({ challenge: ch, role: 'request', signerDigestHex: SIGNER }));
    const a = makeChain(pki, keyDescription({ challenge: ch, role: 'action', signerDigestHex: SIGNER }));
    reqKeys = r.keys;
    const fin = await app.inject({ method: 'POST', url: '/api/voice/pair/finish', payload: { pairId, name: 'Galaxy S24', requestKey: r.spkiB64, actionKey: a.spkiB64, requestChain: r.chain, actionChain: a.chain } });
    deviceId = fin.json().deviceId;
  });
  afterAll(async () => { await app.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const step = (pkg: string) => {
    const url = '/api/voice/screen/step';
    const body = JSON.stringify({ goal: 'open subscriptions', app: { pkg, label: 'X' }, step: 0, done: [],
      elements: [{ i: 1, cls: 'Button', text: 'Subscriptions', desc: '', click: true, edit: false, scroll: false, password: false, id: 'tab', safe: true }] });
    return app.inject({ method: 'POST', url, headers: signer(deviceId, reqKeys.privateKey)('POST', url, body), payload: body });
  };
  it('is off unless voice-config turns it on, and never calls the model while off', async () => {
    on = false; const before = modelCalls;
    expect((await step('com.google.android.youtube')).statusCode).toBe(403);
    expect(modelCalls).toBe(before);
  });
  it('refuses apps outside the phase 1 list before any model call', async () => {
    on = true; const before = modelCalls;
    for (const pkg of ['com.whatsapp', 'com.android.settings', 'com.chase.sig.android']) expect((await step(pkg)).statusCode).toBe(403);
    expect(modelCalls).toBe(before);
  });
  it('returns one validated action for an allowed app', async () => {
    on = true; modelReply = async () => '{"type":"tap","i":1,"why":"open tab"}';
    expect((await step('com.google.android.youtube')).json()).toMatchObject({ type: 'tap', i: 1, commit: false });
  });
  it('a Codex quota error ends the run with a plain reason instead of hanging', async () => {
    on = true; modelReply = async () => { throw new Error('model 503: [codex/gpt-6-luna] [429]: The usage limit has been reached (reset after 30m)'); };
    const r = (await step('com.google.android.youtube')).json();
    expect(r).toMatchObject({ type: 'fail', quota: true });
    expect(r.say).toContain('30 minutes');
  });
});
