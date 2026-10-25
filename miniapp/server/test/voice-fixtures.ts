/**
 * Builds fake Android attestation chains for tests, signed by a throwaway
 * test root (never Google's). Uses the system openssl only to mint X.509
 * certificates; the KeyDescription extension is hand-encoded DER so each
 * test can flip exactly one property.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OPENSSL = fs.existsSync('/usr/bin/openssl') ? '/usr/bin/openssl' : 'openssl';

function len(n: number): Buffer {
  if (n < 128) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: Buffer | number, content: Buffer) => Buffer.concat([typeof tag === 'number' ? Buffer.from([tag]) : tag, len(content.length), content]);
export const seq = (...xs: Buffer[]) => tlv(0x30, Buffer.concat(xs));
export const set = (...xs: Buffer[]) => tlv(0x31, Buffer.concat(xs));
export const int = (n: number) => tlv(0x02, n < 128 ? Buffer.from([n]) : Buffer.from([n >> 8, n & 0xff]));
export const enm = (n: number) => tlv(0x0a, Buffer.from([n]));
export const oct = (b: Buffer) => tlv(0x04, b);
export const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
export const nul = () => Buffer.from([0x05, 0x00]);
/** [n] EXPLICIT, context-specific constructed, high-tag form when n > 30. */
export function ctx(n: number, inner: Buffer): Buffer {
  let tag: Buffer;
  if (n <= 30) tag = Buffer.from([0xa0 | n]);
  else {
    const parts: number[] = [];
    let v = n;
    parts.unshift(v & 0x7f);
    v >>= 7;
    while (v > 0) {
      parts.unshift(0x80 | (v & 0x7f));
      v >>= 7;
    }
    tag = Buffer.from([0xbf, ...parts]);
  }
  return tlv(tag, inner);
}

export interface KdOptions {
  keyLevel?: number;
  level?: number; // 0 software, 1 tee, 2 strongbox
  challenge: Buffer;
  deviceLocked?: boolean;
  bootState?: number;
  pkg?: string;
  signerDigestHex?: string;
  role: 'request' | 'action';
  /** Override the role's normal key rules. */
  unlockedRequired?: boolean;
  noAuthRequired?: boolean;
  userAuthType?: number | null;
  authTimeout?: number | null;
}

export function keyDescription(o: KdOptions): Buffer {
  const level = o.level ?? 1;
  const rot = seq(oct(crypto.randomBytes(32)), bool(o.deviceLocked ?? true), enm(o.bootState ?? 0), oct(crypto.randomBytes(32)));
  const appId = seq(set(seq(oct(Buffer.from(o.pkg ?? 'app.aside.mobile')), int(1))), set(oct(Buffer.from(o.signerDigestHex ?? 'ab'.repeat(32), 'hex'))));
  const hw: Buffer[] = [ctx(704, rot)];
  const unlocked = o.unlockedRequired ?? o.role === 'request';
  const noAuth = o.noAuthRequired ?? o.role === 'request';
  const uat = o.userAuthType === undefined ? (o.role === 'action' ? 2 : null) : o.userAuthType;
  if (noAuth) hw.push(ctx(503, nul()));
  if (uat !== null) hw.push(ctx(504, int(uat)));
  if (o.authTimeout !== undefined && o.authTimeout !== null) hw.push(ctx(505, int(o.authTimeout)));
  if (unlocked) hw.push(ctx(509, nul()));
  const sw = seq(ctx(709, oct(appId)));
  return seq(int(200), enm(level), int(200), enm(o.keyLevel ?? level), oct(o.challenge), oct(Buffer.alloc(0)), sw, seq(...hw.sort((a, b) => a.compare(b))));
}

export interface TestPki {
  dir: string;
  rootKey: string;
  rootCert: string;
  rootSpkiSha256: string;
}

export function makeRoot(): TestPki {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-pki-'));
  const rootKey = path.join(dir, 'root.key');
  const rootCert = path.join(dir, 'root.pem');
  fs.writeFileSync(path.join(dir, 'openssl.cnf'), '[req]\ndistinguished_name = dn\nx509_extensions = v3_ca\n[dn]\n[v3_ca]\nbasicConstraints = critical,CA:true\nkeyUsage = critical,keyCertSign\n');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  fs.writeFileSync(rootKey, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  execFileSync(OPENSSL, ['req', '-config', path.join(dir, 'openssl.cnf'), '-new', '-x509', '-key', rootKey, '-subj', '/CN=Test Attestation Root', '-days', '30', '-out', rootCert], { stdio: 'pipe' });
  const x = new crypto.X509Certificate(fs.readFileSync(rootCert));
  const spki = crypto.createHash('sha256').update(x.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { dir, rootKey, rootCert, rootSpkiSha256: spki };
}

/** Returns [leafPem, rootPem] for a freshly generated device key, plus the key pair. */
export function makeChain(pki: TestPki, kd: Buffer, keyPair?: crypto.KeyPairKeyObjectResult): { chain: string[]; keys: crypto.KeyPairKeyObjectResult; spkiB64: string; serial: string } {
  const keys = keyPair ?? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const id = crypto.randomBytes(4).toString('hex');
  const leafKey = path.join(pki.dir, `leaf-${id}.key`);
  const csr = path.join(pki.dir, `leaf-${id}.csr`);
  const ext = path.join(pki.dir, `leaf-${id}.ext`);
  const leaf = path.join(pki.dir, `leaf-${id}.pem`);
  fs.writeFileSync(leafKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(ext, `1.3.6.1.4.1.11129.2.1.17=DER:${kd.toString('hex').toUpperCase()}\n`);
  execFileSync(OPENSSL, ['req', '-config', path.join(pki.dir, 'openssl.cnf'), '-new', '-key', leafKey, '-subj', '/CN=Android Keystore Key', '-out', csr], { stdio: 'pipe' });
  execFileSync(
    OPENSSL,
    ['x509', '-req', '-in', csr, '-CA', pki.rootCert, '-CAkey', pki.rootKey, '-set_serial', `0x${id}`, '-days', '30', '-extfile', ext, '-out', leaf],
    { stdio: 'pipe' },
  );
  const spkiB64 = Buffer.from(keys.publicKey.export({ type: 'spki', format: 'der' })).toString('base64');
  return { chain: [fs.readFileSync(leaf, 'utf8'), fs.readFileSync(pki.rootCert, 'utf8')], keys, spkiB64, serial: id.replace(/^0+/, '') };
}
