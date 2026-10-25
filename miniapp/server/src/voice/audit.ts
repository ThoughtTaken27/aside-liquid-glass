/**
 * Append-only, hash-chained log of everything the voice assistant did or
 * refused. Each line carries the hash of the line before it, so editing or
 * deleting a past entry breaks the chain and `verifyAuditChain` says where.
 *
 * Never logs audio, and keeps free text short.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  at: string;
  kind: string;
  deviceId: string | null;
  tier: 'A' | 'B' | 'C' | 'D' | null;
  ok: boolean;
  detail: string;
  prev: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function entryHash(e: Omit<AuditEntry, 'hash'>): string {
  return crypto.createHash('sha256').update(JSON.stringify([e.at, e.kind, e.deviceId, e.tier, e.ok, e.detail, e.prev])).digest('hex');
}

export class AuditLog {
  readonly file: string;
  private last: string | null = null;
  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'voice-audit.jsonl');
  }

  private lastHash(): string {
    if (this.last) return this.last;
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trimEnd().split('\n');
      const tail = lines[lines.length - 1];
      this.last = tail ? (JSON.parse(tail) as AuditEntry).hash : GENESIS;
    } catch {
      this.last = GENESIS;
    }
    return this.last;
  }

  write(e: { kind: string; deviceId?: string | null; tier?: AuditEntry['tier']; ok: boolean; detail?: string }): AuditEntry {
    const base = {
      at: new Date().toISOString(),
      kind: e.kind.slice(0, 40),
      deviceId: e.deviceId ?? null,
      tier: e.tier ?? null,
      ok: e.ok,
      detail: (e.detail ?? '').replace(/\s+/g, ' ').slice(0, 300),
      prev: this.lastHash(),
    };
    const full: AuditEntry = { ...base, hash: entryHash(base) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(full) + '\n', { mode: 0o600 });
    this.last = full.hash;
    return full;
  }

  recent(limit = 50): AuditEntry[] {
    try {
      return fs
        .readFileSync(this.file, 'utf8')
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((l) => JSON.parse(l) as AuditEntry);
    } catch {
      return [];
    }
  }
}

/** Returns the index of the first broken line, or -1 if the chain is intact. */
export function verifyAuditChain(lines: string[]): number {
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let e: AuditEntry;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      return i;
    }
    if (e.prev !== prev) return i;
    const { hash, ...rest } = e;
    if (entryHash(rest) !== hash) return i;
    prev = hash;
  }
  return -1;
}
