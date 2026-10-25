/**
 * Android hardware key attestation, checked on the Mac when the phone pairs.
 *
 * The phone generates its keys inside the secure element / TEE and sends the
 * certificate chain Android Keystore produces for them. This module proves,
 * without trusting the phone's word for any of it:
 *
 *  - the chain is signed link by link up to one of Google's pinned
 *    attestation roots (and no certificate in it is on Google's revocation
 *    list);
 *  - the leaf certifies exactly the public key the phone registered;
 *  - the key was made in hardware (TEE or StrongBox), never in software;
 *  - our one-time pairing challenge is inside it (no replayed chains);
 *  - the bootloader is locked and boot is verified (a rooted phone fails);
 *  - the key belongs to our package, signed with our release certificate;
 *  - the key's own rules: the request key only works while the phone is
 *    unlocked, and the action key needs a fresh strong biometric every use.
 *
 * Anything it cannot read, it rejects. There is no "soft pass".
 */
import crypto from 'node:crypto';
import { children, readBoolean, readInteger, readNode, readOctets, type DerNode, DerError } from './der.js';

/** SHA-256 of the SubjectPublicKeyInfo of Google's attestation roots (android.googleapis.com/attestation/root, Oct 2026). */
export const GOOGLE_ROOT_SPKI_SHA256 = [
  'feb2ea7551ee316ed4bb443c8293b884dbfdea40b603ee3e4f4a897e4580fbae', // RSA root (legacy, valid to 2042)
  '3ee44512a1af2beb39c889490c60ea3f82e43f5d5a5532f5ab9419f676cd07ec', // EC "Key Attestation CA1" (valid to 2035)
];

const KEY_DESCRIPTION_OID = Buffer.from([0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x11]);

export type SecurityLevel = 'software' | 'tee' | 'strongbox';
export type KeyRole = 'request' | 'action';

export interface AttestationFacts {
  securityLevel: SecurityLevel;
  attestationSecurityLevel: SecurityLevel;
  challenge: Buffer;
  deviceLocked: boolean;
  verifiedBootState: number;
  packageNames: string[];
  signatureDigests: string[];
  unlockedDeviceRequired: boolean;
  noAuthRequired: boolean;
  userAuthType: number | null;
  authTimeout: number | null;
}

export interface VerifyOptions {
  /** Verification clock; tests only override. */
  now?: number;
  challenge: Buffer;
  role: KeyRole;
  expectedPackage: string;
  /** Lowercase hex SHA-256 of the APK signing certificate. Empty = not configured = reject. */
  expectedSigningDigest: string;
  /** Override for tests. */
  rootSpkiSha256?: string[];
  /** Revoked serials (lowercase hex, no leading zeros). */
  revokedSerials?: Set<string>;
}

export class AttestationError extends Error {
  constructor(readonly code: string, msg?: string) {
    super(msg ?? code);
    this.name = 'AttestationError';
  }
}

function spkiSha256(cert: crypto.X509Certificate): string {
  return crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

export function serialKey(cert: crypto.X509Certificate): string {
  return cert.serialNumber.toLowerCase().replace(/^0+(?=.)/, '');
}

/** Find the KeyDescription extension's inner bytes in a DER certificate. */
export function keyDescriptionBytes(certDer: Buffer): Buffer | null {
  const cert = readNode(certDer);
  const tbs = children(cert)[0];
  for (const field of children(tbs)) {
    // extensions: [3] EXPLICIT SEQUENCE OF Extension
    if (field.cls === 2 && field.tag === 3) {
      const list = children(field)[0];
      for (const ext of children(list)) {
        const parts = children(ext);
        const oidNode = parts[0];
        if (oidNode.cls !== 0 || oidNode.tag !== 6 || oidNode.value.length > 127) continue;
        const encodedOid = Buffer.concat([Buffer.from([0x06, oidNode.value.length]), oidNode.value]);
        if (!encodedOid.equals(KEY_DESCRIPTION_OID)) continue;
        const valueNode = parts[parts.length - 1];
        return readOctets(valueNode);
      }
    }
  }
  return null;
}

function levelOf(n: number): SecurityLevel {
  if (n === 1) return 'tee';
  if (n === 2) return 'strongbox';
  return 'software';
}

/** Index an AuthorizationList (SEQUENCE of [tag] EXPLICIT values) by tag. */
function authList(node: DerNode): Map<number, DerNode> {
  const out = new Map<number, DerNode>();
  for (const c of children(node)) {
    if (c.cls !== 2) continue;
    const inner = c.constructed ? children(c) : [];
    if (inner.length === 1) out.set(c.tag, inner[0]);
  }
  return out;
}

export function parseKeyDescription(bytes: Buffer): AttestationFacts {
  const seq = children(readNode(bytes));
  if (seq.length < 8) throw new AttestationError('bad_key_description');
  const attestationLevel = readInteger(seq[1]);
  const challenge = readOctets(seq[4]);
  const sw = authList(seq[6]);
  const hw = authList(seq[7]);
  const either = (tag: number) => hw.get(tag) ?? sw.get(tag);

  const rot = hw.get(704);
  if (!rot) throw new AttestationError('no_root_of_trust');
  const rotParts = children(rot);
  const deviceLocked = readBoolean(rotParts[1]);
  const verifiedBootState = readInteger(rotParts[2]);

  const packageNames: string[] = [];
  const signatureDigests: string[] = [];
  const appIdNode = either(709);
  if (appIdNode) {
    const appId = children(readNode(readOctets(appIdNode)));
    for (const pkg of children(appId[0])) {
      const p = children(pkg);
      packageNames.push(readOctets(p[0]).toString('utf8'));
    }
    for (const d of children(appId[1])) signatureDigests.push(readOctets(d).toString('hex'));
  }
  const intOrNull = (n: DerNode | undefined) => (n ? readInteger(n) : null);
  return {
    securityLevel: levelOf(readInteger(seq[3])),
    attestationSecurityLevel: levelOf(attestationLevel),
    challenge,
    deviceLocked,
    verifiedBootState,
    packageNames,
    signatureDigests,
    unlockedDeviceRequired: either(509) !== undefined,
    noAuthRequired: either(503) !== undefined,
    userAuthType: intOrNull(either(504)),
    authTimeout: intOrNull(either(505)),
  };
}

/**
 * Verify a chain (leaf first, PEM or base64 DER) for a registered public
 * key. Returns the parsed facts on success; throws AttestationError otherwise.
 */
export function verifyAttestation(chain: string[], publicKeySpkiDer: Buffer, opts: VerifyOptions): AttestationFacts {
  if (!Array.isArray(chain) || chain.length < 2 || chain.length > 10) throw new AttestationError('bad_chain_length');
  if (!opts.expectedSigningDigest || !/^[0-9a-f]{64}$/.test(opts.expectedSigningDigest)) {
    throw new AttestationError('signing_digest_not_configured');
  }
  let certs: crypto.X509Certificate[];
  let ders: Buffer[];
  try {
    ders = chain.map((c) =>
      c.includes('BEGIN CERTIFICATE')
        ? Buffer.from(c.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
        : Buffer.from(c, 'base64'),
    );
    certs = ders.map((d) => new crypto.X509Certificate(d));
  } catch {
    throw new AttestationError('bad_certificate');
  }

  // Every certificate must be valid now, including the pinned root.
  const clock = opts.now ?? Date.now();
  for (const cert of certs) {
    const start = Date.parse(cert.validFrom), end = Date.parse(cert.validTo);
    if (!Number.isFinite(start) || !Number.isFinite(end) || clock < start || clock > end) throw new AttestationError('certificate_time_invalid');
  }

  // 1. Signatures, link by link, and the pinned root.
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) throw new AttestationError('broken_chain', `link ${i}`);
    if (!certs[i + 1].ca || !certs[i].checkIssued(certs[i + 1])) throw new AttestationError('invalid_issuer');
  }
  const root = certs[certs.length - 1];
  if (!root.verify(root.publicKey)) throw new AttestationError('root_not_self_signed');
  const roots = opts.rootSpkiSha256 ?? GOOGLE_ROOT_SPKI_SHA256;
  if (!roots.includes(spkiSha256(root))) throw new AttestationError('unknown_root');

  // 2. Revocation.
  if (opts.revokedSerials) {
    for (const c of certs) if (opts.revokedSerials.has(serialKey(c))) throw new AttestationError('revoked_certificate');
  }

  // 3. The leaf certifies exactly the registered key.
  const leafSpki = Buffer.from(certs[0].publicKey.export({ type: 'spki', format: 'der' }));
  if (!leafSpki.equals(publicKeySpkiDer)) {
    throw new AttestationError('key_mismatch');
  }

  // 4. The attestation record.
  let facts: AttestationFacts;
  try {
    const kd = keyDescriptionBytes(ders[0]);
    if (!kd) throw new AttestationError('no_key_description');
    facts = parseKeyDescription(kd);
  } catch (err) {
    if (err instanceof AttestationError) throw err;
    if (err instanceof DerError) throw new AttestationError('bad_key_description', err.message);
    throw err;
  }
  if (facts.securityLevel === 'software' || facts.attestationSecurityLevel === 'software') throw new AttestationError('software_key');
  if (facts.challenge.length !== opts.challenge.length || !crypto.timingSafeEqual(facts.challenge, opts.challenge)) {
    throw new AttestationError('challenge_mismatch');
  }
  if (!facts.deviceLocked) throw new AttestationError('bootloader_unlocked');
  if (facts.verifiedBootState !== 0) throw new AttestationError('boot_not_verified');
  if (!facts.packageNames.includes(opts.expectedPackage)) throw new AttestationError('wrong_package');
  if (!facts.signatureDigests.includes(opts.expectedSigningDigest)) throw new AttestationError('wrong_signer');

  if (opts.role === 'request') {
    if (!facts.unlockedDeviceRequired) throw new AttestationError('request_key_works_while_locked');
  } else {
    // Fresh strong biometric per use: auth required, biometric bit set, no timeout window.
    if (facts.noAuthRequired) throw new AttestationError('action_key_without_auth');
    if (facts.userAuthType !== 2) throw new AttestationError('action_key_not_biometric');
    if (facts.authTimeout !== null && facts.authTimeout > 0) throw new AttestationError('action_key_has_timeout');
  }
  return facts;
}

/** Google's attestation revocation list; fail closed if it cannot be fetched. */
export async function fetchRevokedSerials(fetchImpl: typeof fetch = fetch): Promise<Set<string>> {
  const res = await fetchImpl('https://android.googleapis.com/attestation/status', { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new AttestationError('revocation_list_unavailable');
  const j = (await res.json()) as { entries?: Record<string, unknown> };
  return new Set(Object.keys(j.entries ?? {}).map((s) => s.toLowerCase().replace(/^0+(?=.)/, '')));
}
