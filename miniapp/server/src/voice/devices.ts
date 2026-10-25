/**
 * Paired phones for the voice assistant.
 *
 * Each phone holds two hardware keys it can never export:
 *  - a request key (works only while the phone is unlocked) that signs every
 *    call to the Mac, and
 *  - an action key (needs a fresh strong fingerprint for every use) that
 *    signs tickets for anything that acts on the world.
 *
 * The registry is a small JSON file read fresh on every check, so revoking a
 * phone (kill switch, duress phrase, or a hand edit) takes effect on the very
 * next request with no restart.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SecurityLevel } from './attestation.js';

export interface VoiceDevice {
  id: string;
  name: string;
  /** SPKI DER, base64. */
  requestKey: string;
  actionKey: string;
  securityLevel: SecurityLevel;
  createdAt: string;
  revokedAt: string | null;
  revokedWhy: string | null;
}

export interface VoiceConfig {
  packageName: string;
  /** Lowercase hex SHA-256 of the APK signing certificate. */
  signingCertSha256: string;
  /** At most this many phones may be paired at once. */
  maxDevices: number;
  /** Area-level fallback for weather when the phone sends no location (rounded to 0.1°, about 11 km). */
  homeLocation: { lat: number; lon: number } | null;
}

/** Finite, in range, and rounded to 0.1° so it never pins down an address. */
export function coarseLocation(v: unknown): { lat: number; lon: number } | null {
  const o = v as { lat?: unknown; lon?: unknown } | null | undefined;
  if (!o || typeof o !== 'object' || typeof o.lat !== 'number' || typeof o.lon !== 'number') return null;
  if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon) || Math.abs(o.lat) > 90 || Math.abs(o.lon) > 180) return null;
  return { lat: Math.round(o.lat * 10) / 10, lon: Math.round(o.lon * 10) / 10 };
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  packageName: 'app.aside.mobile',
  signingCertSha256: '',
  maxDevices: 1,
  homeLocation: null,
};

export function readVoiceConfig(stateDir: string): VoiceConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'voice-config.json'), 'utf8'));
    return {
      packageName: typeof raw.packageName === 'string' ? raw.packageName : DEFAULT_VOICE_CONFIG.packageName,
      signingCertSha256: typeof raw.signingCertSha256 === 'string' ? raw.signingCertSha256.toLowerCase() : '',
      maxDevices: Number.isInteger(raw.maxDevices) && raw.maxDevices > 0 && raw.maxDevices <= 3 ? raw.maxDevices : 1,
      homeLocation: coarseLocation(raw.homeLocation),
    };
  } catch {
    return { ...DEFAULT_VOICE_CONFIG };
  }
}

function writePrivate(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class DeviceRegistry {
  readonly file: string;
  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'voice-devices.json');
  }

  list(): VoiceDevice[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(raw.devices) ? (raw.devices as VoiceDevice[]) : [];
    } catch {
      return [];
    }
  }

  private save(devices: VoiceDevice[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writePrivate(this.file, JSON.stringify({ devices }, null, 2));
  }

  /** An active (not revoked) device, or null. */
  active(id: string): VoiceDevice | null {
    const d = this.list().find((x) => x.id === id);
    return d && !d.revokedAt ? d : null;
  }

  activeCount(): number {
    return this.list().filter((d) => !d.revokedAt).length;
  }

  add(d: Omit<VoiceDevice, 'id' | 'createdAt' | 'revokedAt' | 'revokedWhy'>, maxDevices: number): VoiceDevice {
    const all = this.list();
    if (all.filter((x) => !x.revokedAt).length >= maxDevices) throw new Error('device_limit');
    if (all.some((x) => !x.revokedAt && (x.requestKey === d.requestKey || x.actionKey === d.actionKey))) throw new Error('duplicate_key');
    const dev: VoiceDevice = {
      ...d,
      id: crypto.randomBytes(12).toString('base64url'),
      createdAt: new Date().toISOString(),
      revokedAt: null,
      revokedWhy: null,
    };
    all.push(dev);
    this.save(all);
    return dev;
  }

  revoke(id: string, why: string): boolean {
    const all = this.list();
    let hit = false;
    for (const d of all) {
      if (d.id === id && !d.revokedAt) {
        d.revokedAt = new Date().toISOString();
        d.revokedWhy = why.slice(0, 120);
        hit = true;
      }
    }
    if (hit) this.save(all);
    return hit;
  }

  revokeAll(why: string): number {
    const all = this.list();
    let n = 0;
    for (const d of all) {
      if (!d.revokedAt) {
        d.revokedAt = new Date().toISOString();
        d.revokedWhy = why.slice(0, 120);
        n++;
      }
    }
    if (n) this.save(all);
    return n;
  }
}

export function publicKeyFromSpki(b64: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}
