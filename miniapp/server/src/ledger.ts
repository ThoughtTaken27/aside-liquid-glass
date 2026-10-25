/**
 * The activity ledger: every thing Next or one of its helpers does, in
 * order, in a file he can read on his phone.
 *
 * Tamper-evident, not tamper-proof. Each entry carries the hash of the one
 * before it, and each hash is an HMAC under a key only this Mac holds, so
 * editing, deleting or reordering a line breaks `verify()` at that point.
 * Someone with the key file could rewrite the whole chain; the point is
 * that nothing quiet can happen, not that root cannot lie.
 *
 * What goes in is a short summary, never an email body or page text. That
 * is the caller's job, but everything here is sanitised and capped anyway:
 * control, bidi and zero-width characters are stripped (they are how a
 * line can be made to read differently than it is), whitespace collapsed,
 * lengths capped, detail keys limited to plain identifiers.
 *
 * Storage is append-only JSONL. Past 5 MB the file is renamed aside and a
 * new chain starts whose first `prev` is the old chain's last hash; that
 * anchor is kept next to the file so the new chain still verifies.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type LedgerActor = 'you' | 'sorter' | 'drafter' | 'planner' | 'inspector' | 'agent' | 'system';
export type LedgerRisk = 'none' | 'low' | 'high';
export type LedgerDetail = Record<string, string | number | boolean | null>;

export interface LedgerEntry {
  seq: number;
  at: string;
  actor: LedgerActor;
  kind: string;
  summary: string;
  itemId?: string;
  projectId?: string;
  sessionId?: string;
  detail?: LedgerDetail;
  risk?: LedgerRisk;
  prev: string;
  hash: string;
}

export interface LedgerInput {
  actor: LedgerActor;
  kind: string;
  summary: string;
  itemId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  detail?: Record<string, unknown> | null;
  risk?: LedgerRisk | null;
}

export interface LedgerVerify {
  ok: boolean;
  count: number;
  /** The first seq that does not check out, or null. */
  brokenAt: number | null;
  checkedAt: string;
}

export const LEDGER_ACTORS: readonly LedgerActor[] = [
  'you',
  'sorter',
  'drafter',
  'planner',
  'inspector',
  'agent',
  'system',
];
const AGENT_ACTORS = new Set<LedgerActor>(['inspector', 'agent', 'sorter', 'drafter', 'planner']);
const RISKS = new Set<LedgerRisk>(['none', 'low', 'high']);

export const GENESIS = 'genesis';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SUMMARY = 200;
const MAX_DETAIL_VALUE = 200;
const MAX_DETAIL_KEYS = 12;
const MAX_KIND = 40;
const MAX_ID = 120;
const DETAIL_KEY = /^[a-zA-Z][\w]{0,30}$/;

// C0/C1 controls, bidi embeddings/overrides/isolates and marks, and
// zero-width / invisible formatting characters.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u061C\uFEFF\u00AD\u180E]/g;

export function cleanText(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  const s = String(value)
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function cleanDetail(detail: Record<string, unknown> | null | undefined): LedgerDetail | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const out: LedgerDetail = {};
  let n = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (n >= MAX_DETAIL_KEYS) break;
    if (!DETAIL_KEY.test(key)) continue;
    if (value === null || value === undefined) out[key] = null;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : null;
    else out[key] = cleanText(value, MAX_DETAIL_VALUE);
    n += 1;
  }
  return n ? out : undefined;
}

/** JSON with object keys sorted at every level, so a hash has one input. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function hashOf(key: Buffer, entry: Omit<LedgerEntry, 'hash'>): string {
  return crypto
    .createHmac('sha256', key)
    .update(entry.prev + canonicalJson(entry))
    .digest('hex');
}

function withoutHash(e: LedgerEntry): Omit<LedgerEntry, 'hash'> {
  const { hash: _hash, ...rest } = e;
  return rest;
}

interface Anchor {
  prev: string;
  seq: number;
}

interface Parsed {
  /** One slot per complete line; null when the line is not a valid entry. */
  lines: Array<LedgerEntry | null>;
  /** Byte length up to and including the last newline. */
  completeBytes: number;
  /** A trailing fragment with no newline (a write cut short). */
  partialTail: boolean;
}

function isEntry(v: unknown): v is LedgerEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.seq === 'number' &&
    typeof e.at === 'string' &&
    typeof e.actor === 'string' &&
    typeof e.kind === 'string' &&
    typeof e.summary === 'string' &&
    typeof e.prev === 'string' &&
    typeof e.hash === 'string'
  );
}

export class Ledger {
  private readonly key: Buffer;
  private readonly anchorFile: string;
  private readonly maxBytes: number;
  private lastEntry: LedgerEntry | null = null;

  constructor(
    private readonly file: string,
    keyFile: string,
    opts: { maxBytes?: number } = {},
  ) {
    this.maxBytes = opts.maxBytes ?? MAX_BYTES;
    this.anchorFile = `${file}.anchor.json`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.key = loadKey(keyFile);
    const parsed = this.parse();
    for (let i = parsed.lines.length - 1; i >= 0; i -= 1) {
      const e = parsed.lines[i];
      if (e) {
        this.lastEntry = e;
        break;
      }
    }
    // With no entries yet, the first append continues from the rotation
    // anchor if there is one (see append).
  }

  last(): LedgerEntry | null {
    return this.lastEntry;
  }

  append(input: LedgerInput, now = new Date()): LedgerEntry {
    if (!LEDGER_ACTORS.includes(input.actor)) throw new Error(`bad ledger actor: ${String(input.actor)}`);
    this.rotateIfNeeded(now);
    this.repairTail();

    const anchor = this.lastEntry ? null : this.readAnchor();
    const prev = this.lastEntry?.hash ?? anchor?.prev ?? GENESIS;
    const seq = (this.lastEntry?.seq ?? anchor?.seq ?? 0) + 1;

    const base: Omit<LedgerEntry, 'hash'> = {
      seq,
      at: now.toISOString(),
      actor: input.actor,
      kind: cleanText(input.kind, MAX_KIND) || 'event',
      summary: cleanText(input.summary, MAX_SUMMARY),
      prev,
    };
    const itemId = cleanText(input.itemId, MAX_ID);
    const projectId = cleanText(input.projectId, MAX_ID);
    const sessionId = cleanText(input.sessionId, MAX_ID);
    if (itemId) base.itemId = itemId;
    if (projectId) base.projectId = projectId;
    if (sessionId) base.sessionId = sessionId;
    const detail = cleanDetail(input.detail);
    if (detail) base.detail = detail;
    if (input.risk && RISKS.has(input.risk)) base.risk = input.risk;

    const entry: LedgerEntry = { ...base, hash: hashOf(this.key, base) };
    const existed = fs.existsSync(this.file);
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (!existed) fs.chmodSync(this.file, 0o600);
    this.lastEntry = entry;
    return entry;
  }

  list(opts: { limit?: number; beforeSeq?: number; actor?: LedgerActor | 'agents' } = {}): {
    entries: LedgerEntry[];
    more: boolean;
  } {
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
    const all = this.parse().lines.filter((e): e is LedgerEntry => e !== null);
    const matched: LedgerEntry[] = [];
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const e = all[i];
      if (opts.beforeSeq !== undefined && !(e.seq < opts.beforeSeq)) continue;
      if (opts.actor === 'agents') {
        if (!AGENT_ACTORS.has(e.actor)) continue;
      } else if (opts.actor && e.actor !== opts.actor) continue;
      matched.push(e);
      if (matched.length > limit) break;
    }
    return { entries: matched.slice(0, limit), more: matched.length > limit };
  }

  verify(now = new Date()): LedgerVerify {
    const { lines } = this.parse();
    const anchor = this.readAnchor();
    let prev = anchor?.prev ?? GENESIS;
    let expected = (anchor?.seq ?? 0) + 1;
    let count = 0;
    for (const e of lines) {
      if (!e) return { ok: false, count, brokenAt: expected, checkedAt: now.toISOString() };
      if (e.seq !== expected || e.prev !== prev) {
        return { ok: false, count, brokenAt: expected, checkedAt: now.toISOString() };
      }
      const want = hashOf(this.key, withoutHash(e));
      if (!timingSafeEqualHex(want, e.hash)) {
        return { ok: false, count, brokenAt: e.seq, checkedAt: now.toISOString() };
      }
      prev = e.hash;
      expected += 1;
      count += 1;
    }
    return { ok: true, count, brokenAt: null, checkedAt: now.toISOString() };
  }

  // ------------------------------------------------------------------

  private parse(): Parsed {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { lines: [], completeBytes: 0, partialTail: false };
    }
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl >= 0 ? text.slice(0, lastNl) : '';
    const tail = text.slice(lastNl + 1);
    const lines: Array<LedgerEntry | null> = [];
    if (complete.length || lastNl >= 0) {
      for (const line of complete.split('\n')) {
        if (!line.trim()) {
          lines.push(null);
          continue;
        }
        try {
          const v = JSON.parse(line) as unknown;
          lines.push(isEntry(v) ? v : null);
        } catch {
          lines.push(null);
        }
      }
    }
    return {
      lines,
      completeBytes: lastNl >= 0 ? Buffer.byteLength(text.slice(0, lastNl + 1)) : 0,
      partialTail: tail.length > 0,
    };
  }

  /** A write cut short leaves a fragment with no newline; drop it before appending. */
  private repairTail(): void {
    const parsed = this.parse();
    if (parsed.partialTail) fs.truncateSync(this.file, parsed.completeBytes);
  }

  private rotateIfNeeded(now: Date): void {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size <= this.maxBytes || !this.lastEntry) return;
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    let target = `${this.file}.${stamp}.jsonl`;
    for (let i = 1; fs.existsSync(target); i += 1) target = `${this.file}.${stamp}-${i}.jsonl`;
    const anchor: Anchor = { prev: this.lastEntry.hash, seq: this.lastEntry.seq };
    fs.renameSync(this.file, target);
    const tmp = `${this.anchorFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(anchor)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.anchorFile);
    this.lastEntry = null;
  }

  private readAnchor(): Anchor | null {
    try {
      const a = JSON.parse(fs.readFileSync(this.anchorFile, 'utf8')) as Anchor;
      return a && typeof a.prev === 'string' && Number.isInteger(a.seq) ? a : null;
    } catch {
      return null;
    }
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * 32 random bytes, hex, created 0600 on first use. A key file that exists
 * but is malformed is an error: quietly making a new one would make every
 * past entry fail verification and hide whatever broke it.
 */
function loadKey(keyFile: string): Buffer {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(keyFile, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const hex = fs.readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('ledger key file is malformed');
  return Buffer.from(hex, 'hex');
}
