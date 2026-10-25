/**
 * Every voice request is signed by the phone's request key, which lives in
 * the phone's secure hardware and only works while the phone is unlocked.
 * A copied cookie, a leaked URL, or a replayed request gets nothing.
 *
 * Signed string (UTF-8, newline separated):
 *
 *   ASIDE-VOICE-1
 *   <METHOD>
 *   <path and query, exactly as sent>
 *   <device id>
 *   <timestamp, ms since epoch>
 *   <nonce, base64url, 16 to 64 chars>
 *   <lowercase hex SHA-256 of the raw body>
 *
 * Signature: ECDSA P-256 over SHA-256, DER, base64 (Android "SHA256withECDSA").
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceRegistry, VoiceDevice } from './devices.js';
import { publicKeyFromSpki } from './devices.js';

export const SIGNATURE_WINDOW_MS = 60_000;

export class SignatureError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SignatureError';
  }
}

export function canonical(method: string, pathAndQuery: string, deviceId: string, ts: string, nonce: string, bodySha256Hex: string): string {
  return ['ASIDE-VOICE-1', method.toUpperCase(), pathAndQuery, deviceId, ts, nonce, bodySha256Hex].join('\n');
}

export function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Remembers nonces for the signature window so a request can't be replayed. */
export class NonceCache {
  private seen = new Map<string, number>();
  constructor(private readonly ttlMs = SIGNATURE_WINDOW_MS * 2, private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(data) || data.length > 10000 || data.some(e => !Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || typeof e[1] !== 'number')) throw new Error('invalid_nonce_state');
      this.seen = new Map(data as Array<[string, number]>);
    }
  }
  /** True the first time a nonce is seen within its lifetime. */
  claim(key: string, now = Date.now()): boolean {
    for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
    const exp = this.seen.get(key);
    if (exp !== undefined && exp >= now) return false;
    this.seen.set(key, now + this.ttlMs);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify([...this.seen]), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    }
    return true;
  }
}

export interface SignedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

function header(h: SignedRequest['headers'], name: string): string {
  const v = h[name];
  return typeof v === 'string' ? v : '';
}

export function verifySignedRequest(
  req: SignedRequest,
  registry: Pick<DeviceRegistry, 'active'>,
  nonces: NonceCache,
  now = Date.now(),
): VoiceDevice {
  const deviceId = header(req.headers, 'x-aside-device');
  const ts = header(req.headers, 'x-aside-ts');
  const nonce = header(req.headers, 'x-aside-nonce');
  const sig = header(req.headers, 'x-aside-sig');
  if (!deviceId || !ts || !nonce || !sig) throw new SignatureError('missing');
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(deviceId)) throw new SignatureError('bad_device');
  if (!/^\d{12,14}$/.test(ts)) throw new SignatureError('bad_ts');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new SignatureError('bad_nonce');
  if (Math.abs(now - Number(ts)) > SIGNATURE_WINDOW_MS) throw new SignatureError('stale');
  const device = registry.active(deviceId);
  if (!device) throw new SignatureError('unknown_device');
  const msg = canonical(req.method, req.url, deviceId, ts, nonce, sha256Hex(req.rawBody));
  let ok = false;
  try {
    ok = crypto.verify('sha256', Buffer.from(msg, 'utf8'), { key: publicKeyFromSpki(device.requestKey), dsaEncoding: 'der' }, Buffer.from(sig, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) throw new SignatureError('bad_signature');
  // Claimed only after the signature checks out, so garbage can't burn nonces.
  if (!nonces.claim(`${deviceId}:${nonce}`, now)) throw new SignatureError('replay');
  return device;
}

// ---------------------------------------------------------------------------
// Action tickets: a fresh fingerprint signs the exact action.

export interface ActionTicket {
  /** Canonical JSON of the action, as shown to the user. */
  action: string;
  ts: string;
  nonce: string;
  /** Base64 DER ECDSA signature by the action key over ticketString(). */
  sig: string;
}

export function ticketString(deviceId: string, t: Pick<ActionTicket, 'action' | 'ts' | 'nonce'>): string {
  return ['ASIDE-ACTION-1', deviceId, t.ts, t.nonce, sha256Hex(t.action)].join('\n');
}

export function verifyTicket(device: VoiceDevice, t: ActionTicket, nonces: NonceCache, now = Date.now()): Record<string, unknown> {
  if (!t || typeof t.action !== 'string' || typeof t.ts !== 'string' || typeof t.nonce !== 'string' || typeof t.sig !== 'string') {
    throw new SignatureError('bad_ticket');
  }
  if (t.action.length > 8000) throw new SignatureError('ticket_too_big');
  if (!/^\d{12,14}$/.test(t.ts) || Math.abs(now - Number(t.ts)) > SIGNATURE_WINDOW_MS) throw new SignatureError('ticket_stale');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(t.nonce)) throw new SignatureError('bad_ticket');
  let ok = false;
  try {
    ok = crypto.verify(
      'sha256',
      Buffer.from(ticketString(device.id, t), 'utf8'),
      { key: publicKeyFromSpki(device.actionKey), dsaEncoding: 'der' },
      Buffer.from(t.sig, 'base64'),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new SignatureError('bad_ticket_signature');
  if (!nonces.claim(`ticket:${device.id}:${t.nonce}`, now)) throw new SignatureError('ticket_replay');
  let parsed: unknown;
  try {
    parsed = JSON.parse(t.action);
  } catch {
    throw new SignatureError('bad_ticket');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SignatureError('bad_ticket');
  return parsed as Record<string, unknown>;
}
