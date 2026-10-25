/**
 * Owner-controlled local factual memory, not an activity collector or model.
 * Only the structured projection in context.ts may enter. No page/body/typed text.
 * The journal is sealed and private; a co-located key does NOT protect against
 * the logged-in owner, root, malware, disk backups or an endpoint compromise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';
import { buildLocalContext, type ContextRecord, type ContextSource, type LocalContext } from './context.js';
import type { RawItem } from './next.js';
import { trailKey, type TrailEntry } from './worktrail.js';

// Lazy, existing Node built-in: default-off startup does not initialize SQLite.
const require = createRequire(import.meta.url);
const openDatabase = (file: string, options: DatabaseSyncOptions): DatabaseSync => new (require('node:sqlite').DatabaseSync)(file, options);
const DAY = 86_400_000;
const MAX_EVENTS = 2500;
const MAX_BYTES = 4_000_000;
const MAX_FILE_BYTES = 12_000_000; // SQLite may temporarily retain freed encrypted pages.
const CONSENT = 'local-structured-context-v1';
const SOURCES: readonly ContextSource[] = ['schoology', 'work-trail'];
export type MemorySpace = 'school' | 'personal';
export interface MemoryPreferences {
  enabled: boolean;
  sources: ContextSource[];
  pausedUntil: string | 'until-resumed' | null;
  retentionDays: 7 | 14 | 30;
  excludedHosts: string[];
}
export interface MemoryEvent extends ContextRecord {
  id: string;
  title: string;
  url: string | null;
  space: MemorySpace;
  observedAt: string;
}
export interface DocumentBinding { taskId: string; title: string; space: MemorySpace; sourceId: string; url: string; originURL: string | null; linkedAt: string }
export interface DocumentView { taskId: string; revision: number; enabled: boolean; binding: DocumentBinding | null }
interface ForgetRule { from: number; to: number; source?: ContextSource; taskId?: string; sourceId?: string; host?: string }
interface Journal {
  version: 1;
  revision: number;
  prefs: MemoryPreferences;
  events: MemoryEvent[];
  bindings: DocumentBinding[];
  forgotten: ForgetRule[];
  retainedAfter: number;
  capped: boolean;
}
export interface MemoryStatus {
  revision: number;
  preferences: MemoryPreferences;
  state: 'off' | 'paused' | 'ready';
  processing: 'local-factual';
  count: number;
  documentCount: number;
  storageBytes: number;
  firstEventAt: string | null;
  averageDailyBytes: number | null;
  capped: boolean;
  sources: Array<{ id: ContextSource; label: string; enabled: boolean; count: number; lastObservedAt: string | null }>;
}
export interface MemoryWindow {
  id: string;
  from: string;
  to: string;
  title: string;
  summary: string;
  evidence: MemoryEvent[];
}
export interface MemoryHistory {
  revision: number;
  events: MemoryEvent[];
  windows: MemoryWindow[];
  total: number;
  more: boolean;
  queryKind: 'chronological' | 'lexical';
}
export type ForgetTarget = { kind: 'all' | 'ten-minutes' | 'hour' | 'today' } | { kind: 'source'; source: ContextSource } | { kind: 'item'; taskId: string };
export class ContextMemoryError extends Error {
  constructor(readonly code: 'context_unavailable' | 'revision_changed' | 'invalid_context_settings' | 'context_consent_required' | 'retention_confirmation_required' | 'exclusion_confirmation_required' | 'invalid_context_query' | 'invalid_forget_target' | 'forget_limit' | 'invalid_document_link' | 'document_already_linked' | 'context_source_required' | 'document_limit', readonly status = 400) { super(code); }
}
const defaults = (): Journal => ({ version: 1, revision: 0, prefs: { enabled: false, sources: [], pausedUntil: null, retentionDays: 14, excludedHosts: [] }, events: [], bindings: [], forgotten: [], retainedAfter: 0, capped: false });
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max);
const iso = (v: unknown) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const host = (url: string | null) => { try { return new URL(url!).hostname.toLowerCase(); } catch { return ''; } };
const blocked = (url: string | null, exclusions: string[]) => { const h = host(url); return exclusions.some(x => h === x || h.endsWith('.' + x)); };
const paused = (p: MemoryPreferences, now: number) => p.pausedUntil === 'until-resumed' || (p.pausedUntil !== null && Date.parse(p.pausedUntil) > now);
const canonicalURL = (v: string | null): string | null => { try { const u = new URL(v!); if (u.protocol !== 'https:' || u.username || u.password || u.pathname.length > 512) return null; u.search = ''; u.hash = ''; return u.href; } catch { return null; } };
const inRule = (e: MemoryEvent, r: ForgetRule) => Date.parse(e.observedAt) >= r.from && Date.parse(e.observedAt) <= r.to && (!r.source || r.source === e.source) && (!r.taskId || r.taskId === e.taskId) && (!r.sourceId || r.sourceId === e.sourceId) && (!r.host || blocked(e.url, [r.host]));
const fresh = (e: ContextRecord, now: number): ContextRecord['freshness'] => !e.observedAt || !e.expiresAt ? 'unknown' : Date.parse(e.expiresAt) > now ? 'fresh' : 'stale';
const copy = <T>(x: T): T => structuredClone(x);
function dayKey(at: number): string { const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at); return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k)!.value).join('-'); }
function dayStart(now: number): number {
  const desired = Date.parse(dayKey(now) + 'T00:00:00Z');
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let candidate = desired;
  for (let i = 0; i < 3; i += 1) {
    const p = f.formatToParts(candidate); const value = (key: string) => Number(p.find(x => x.type === key)!.value);
    const localAsUTC = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
    candidate = desired - (localAsUTC - candidate);
  }
  return candidate;
}
function preferences(v: unknown): v is MemoryPreferences {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return Object.keys(p).length === 5 && Object.keys(p).every(k => ['enabled', 'sources', 'pausedUntil', 'retentionDays', 'excludedHosts'].includes(k)) && typeof p.enabled === 'boolean'
    && Array.isArray(p.sources) && p.sources.length <= 2 && p.sources.every(s => SOURCES.includes(s)) && new Set(p.sources).size === p.sources.length && (!p.enabled || p.sources.length > 0)
    && (p.pausedUntil === null || p.pausedUntil === 'until-resumed' || iso(p.pausedUntil)) && [7, 14, 30].includes(Number(p.retentionDays)) && typeof p.retentionDays === 'number'
    && Array.isArray(p.excludedHosts) && p.excludedHosts.length <= 50 && p.excludedHosts.every(s => typeof s === 'string' && s.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)) && new Set(p.excludedHosts).size === p.excludedHosts.length;
}
function validEvent(v: unknown): v is MemoryEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as MemoryEvent;
  const keys = ['id', 'taskId', 'source', 'sourceId', 'kind', 'observedAt', 'expiresAt', 'freshness', 'confidence', 'value', 'minutes', 'title', 'url', 'space'];
  return Object.keys(e).every(k => keys.includes(k)) && /^[a-f0-9]{32}$/.test(e.id) && typeof e.taskId === 'string' && /^[\w:.-]{1,140}$/.test(e.taskId) && SOURCES.includes(e.source)
    && typeof e.sourceId === 'string' && /^[\w:.-]{1,160}$/.test(e.sourceId) && typeof e.title === 'string' && e.title.length <= 180 && (e.url === null || canonicalURL(e.url) === e.url) && ['school', 'personal'].includes(e.space)
    && iso(e.observedAt) && (e.expiresAt === null || iso(e.expiresAt)) && ['fresh', 'stale', 'unknown'].includes(e.freshness) && ['structured-source', 'exact-identity', 'unknown'].includes(e.confidence)
    && ((e.source === 'schoology' && e.kind === 'source-status' && e.confidence === 'structured-source' && /^schoology:\d{6,25}$/.test(e.taskId) && e.sourceId === e.taskId && ['reported-open', 'reported-complete'].includes(e.value!) && e.minutes === undefined)
      || (e.source === 'work-trail' && e.kind === 'foreground-activity' && e.confidence === 'exact-identity' && e.value === undefined && Number.isInteger(e.minutes) && e.minutes! > 0 && e.minutes! <= 1440));
}

export function canonicalDocument(v: unknown): { sourceId: string; url: string } | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  try { const u = new URL(v); if (u.protocol !== 'https:' || u.username || u.password || u.hostname !== 'docs.google.com' || u.port) return null; const key = trailKey(u.href); if (!key || !['Doc', 'Slides', 'Sheet', 'Form'].includes(key.kind)) return null; return { sourceId: key.key, url: key.url }; } catch { return null; }
}
function validBinding(v: unknown): v is DocumentBinding {
  if (!v || typeof v !== 'object') return false; const b = v as DocumentBinding;
  const doc = canonicalDocument(b.url);
  return Object.keys(b).length === 7 && Object.keys(b).every(k => ['taskId', 'title', 'space', 'sourceId', 'url', 'originURL', 'linkedAt'].includes(k)) && typeof b.taskId === 'string' && typeof b.sourceId === 'string' && /^[\w:.-]{1,140}$/.test(b.taskId) && typeof b.title === 'string' && b.title.length <= 180 && ['school', 'personal'].includes(b.space) && !!doc && doc.sourceId === b.sourceId && doc.url === b.url && (b.originURL === null || canonicalURL(b.originURL) === b.originURL) && iso(b.linkedAt);
}

export class ContextMemory {
  private readonly dir: string;
  private transactionDB: DatabaseSync | null = null;
  private initialDatabase = false;
  constructor(asideRoot: string) { this.dir = path.join(asideRoot, 'next', 'context-memory'); }

  /** Neither startup nor a default-off status creates directories or keys. */
  private privateDirectory(create = false): boolean {
    try {
      const parent = fs.lstatSync(path.dirname(this.dir));
      if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) || (process.getuid && parent.uid !== process.getuid())) throw new Error('unsafe parent');
      if (create && !fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { mode: 0o700 });
      const s = fs.lstatSync(this.dir);
      if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) throw new Error('unsafe directory');
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !create) return false;
      throw new ContextMemoryError('context_unavailable', 503);
    }
  }
  private readPrivate(name: string, max: number): Buffer | null {
    let fd: number | undefined;
    try {
      fd = fs.openSync(path.join(this.dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.size > max || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) throw new Error('unsafe file');
      // The database bytes are not an input buffer: only validate its private
      // file/header before SQLite reads the bounded encrypted row.
      const length = name === 'journal.sealed' ? Math.min(32, s.size) : Math.min(max + 1, s.size + 1);
      const b = Buffer.alloc(length); const n = fs.readSync(fd, b, 0, b.length, 0);
      if (n > max) throw new Error('oversized');
      return b.subarray(0, n);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new ContextMemoryError('context_unavailable', 503);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  private read(now: number): Journal {
    if (!this.privateDirectory()) return defaults();
    const key = this.readPrivate('key', 32), file = this.readPrivate('journal.sealed', MAX_FILE_BYTES);
    if (this.initialDatabase && this.transactionDB) return defaults();
    if (!key && !file) return defaults();
    if (!key || key.length !== 32 || !file || file.length < 16) throw new ContextMemoryError('context_unavailable', 503);
    let db: DatabaseSync | undefined;
    try {
      // This Next-owned journal may recover its own interrupted transaction;
      // it never opens an original browser/activity/source database for writing.
      db = this.transactionDB ?? openDatabase(path.join(this.dir, 'journal.sealed'), { allowExtension: false });
      const row = db.prepare('SELECT sealed FROM memory WHERE id = 1').get() as { sealed?: Uint8Array } | undefined;
      if (!row?.sealed || !(row.sealed instanceof Uint8Array)) throw new Error('missing journal');
      const encoded = Buffer.from(row.sealed);
      if (encoded.length < 30 || encoded.length > MAX_BYTES) throw new Error('size');
      const decrypt = createDecipheriv('aes-256-gcm', key, encoded.subarray(1, 13)); decrypt.setAAD(Buffer.from('Next local context v1')); decrypt.setAuthTag(encoded.subarray(13, 29));
      if (encoded[0] !== 1) throw new Error('version');
      const j = JSON.parse(Buffer.concat([decrypt.update(encoded.subarray(29)), decrypt.final()]).toString('utf8')) as Journal;
      if (![7, 8].includes(Object.keys(j).length) || Object.keys(j).some(k => !['version','revision','prefs','events','bindings','forgotten','retainedAfter','capped'].includes(k)) || (j.bindings !== undefined && (!Array.isArray(j.bindings) || j.bindings.length > 50 || !j.bindings.every(validBinding) || new Set(j.bindings.map(b => b.taskId)).size !== j.bindings.length || new Set(j.bindings.map(b => b.sourceId)).size !== j.bindings.length)) || j.version !== 1 || !Number.isSafeInteger(j.revision) || j.revision < 0 || !preferences(j.prefs) || !Array.isArray(j.events) || j.events.length > MAX_EVENTS || !j.events.every(validEvent)
        || !Number.isFinite(j.retainedAfter) || j.retainedAfter < 0 || typeof j.capped !== 'boolean' || !Array.isArray(j.forgotten) || j.forgotten.length > 1000 || !j.forgotten.every(r => r && typeof r === 'object' && Object.keys(r).every(k => ['from', 'to', 'source', 'taskId', 'sourceId', 'host'].includes(k)) && Number.isFinite(r.from) && Number.isFinite(r.to) && r.from >= 0 && r.to >= r.from && (r.source === undefined || SOURCES.includes(r.source)) && (r.taskId === undefined || (typeof r.taskId === 'string' && /^[\w:.-]{1,140}$/.test(r.taskId))) && (r.sourceId === undefined || (typeof r.sourceId === 'string' && /^[\w:.-]{1,200}$/.test(r.sourceId))) && (r.host === undefined || (typeof r.host === 'string' && /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(r.host))))) throw new Error('schema');
      j.bindings ??= []; return j;
    } catch (e) { if (e instanceof ContextMemoryError) throw e; throw new ContextMemoryError('context_unavailable', 503); }
    finally { if (db && db !== this.transactionDB) db.close(); }
  }
  /** SQLite transactions fence all processes and recover OS locks after crashes. */
  private withLock<T>(expected: number, now: number, update: (j: Journal) => T): T {
    if (!Number.isFinite(now) || !Number.isSafeInteger(expected) || expected < 0) throw new ContextMemoryError('invalid_context_settings');
    this.privateDirectory(true);
    const file = path.join(this.dir, 'journal.sealed');
    const existing = this.readPrivate('journal.sealed', MAX_FILE_BYTES);
    if (!existing) {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.closeSync(fd);
    }
    let db: DatabaseSync | undefined;
    try {
      db = openDatabase(file, { allowExtension: false });
      db.exec('PRAGMA busy_timeout = 100; PRAGMA trusted_schema = OFF; PRAGMA secure_delete = ON; BEGIN IMMEDIATE');
      this.transactionDB = db; this.initialDatabase = !existing;
      if (!existing) db.exec('CREATE TABLE memory (id INTEGER PRIMARY KEY CHECK (id = 1), sealed BLOB NOT NULL)');
      const j = this.read(now);
      if (j.revision !== expected) throw new ContextMemoryError('revision_changed', 409);
      const result = update(j);
      db.exec('COMMIT'); return result;
    } catch (e) {
      try { db?.exec('ROLLBACK'); } catch { /* SQLite may not have acquired the lock. */ }
      if (e instanceof ContextMemoryError) throw e;
      throw new ContextMemoryError('context_unavailable', 503);
    } finally { this.transactionDB = null; this.initialDatabase = false; db?.close(); }
  }
  private expire(now: number): void {
    const j = this.read(now), cutoff = Math.max(j.retainedAfter, now - j.prefs.retentionDays * DAY);
    if (!j.events.some(e => Date.parse(e.observedAt) < cutoff) && !j.bindings.some(b => Date.parse(b.linkedAt) < cutoff)) return;
    this.withLock(j.revision, now, latest => {
      const boundary = Math.max(latest.retainedAfter, now - latest.prefs.retentionDays * DAY);
      latest.events = latest.events.filter(e => Date.parse(e.observedAt) >= boundary);
      latest.bindings = latest.bindings.filter(b => Date.parse(b.linkedAt) >= boundary);
      latest.retainedAfter = boundary; latest.revision += 1; this.write(latest);
    });
  }
  private write(j: Journal): void {
    this.privateDirectory(true);
    let key = this.readPrivate('key', 32);
    if (!key) {
      key = randomBytes(32);
      const fd = fs.openSync(path.join(this.dir, 'key'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    if (key.length !== 32) throw new ContextMemoryError('context_unavailable', 503);
    if (!this.transactionDB) throw new ContextMemoryError('context_unavailable', 503);
    // The whole encrypted row is replaced atomically, with no plaintext index.
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from('Next local context v1'));
    const data = Buffer.concat([cipher.update(JSON.stringify(j)), cipher.final()]);
    const sealed = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), data]);
    if (sealed.length > MAX_BYTES) throw new ContextMemoryError('context_unavailable', 503);
    this.transactionDB.prepare('INSERT INTO memory (id, sealed) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET sealed = excluded.sealed').run(sealed);
  }
  status(date = new Date()): MemoryStatus {
    const now = date.getTime(); if (!Number.isFinite(now)) throw new ContextMemoryError('invalid_context_query');
    this.expire(now);
    const j = this.read(now), visible = j.events.filter(e => !blocked(e.url, j.prefs.excludedHosts));
    const first = visible.reduce((n, e) => Math.min(n, Date.parse(e.observedAt)), Infinity);
    const bytes = this.privateDirectory() ? fs.statSync(path.join(this.dir, 'journal.sealed'), { throwIfNoEntry: false })?.size ?? 0 : 0;
    return { revision: j.revision, preferences: copy(j.prefs), state: !j.prefs.enabled ? 'off' : paused(j.prefs, now) ? 'paused' : 'ready', processing: 'local-factual', count: visible.length, documentCount: j.bindings.length, storageBytes: bytes, firstEventAt: Number.isFinite(first) ? new Date(first).toISOString() : null,
      averageDailyBytes: Number.isFinite(first) ? Math.round(bytes / Math.max(1, (now - first) / DAY)) : null, capped: j.capped,
      sources: SOURCES.map(id => { const events = visible.filter(e => e.source === id); return { id, label: id === 'schoology' ? 'Schoology task status' : 'Existing work trail', enabled: j.prefs.enabled && j.prefs.sources.includes(id), count: events.length, lastObservedAt: events.reduce<string | null>((a, e) => !a || e.observedAt > a ? e.observedAt : a, null) }; }) };
  }
  configure(input: unknown, date = new Date()): MemoryStatus {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContextMemoryError('invalid_context_settings');
    const p = input as Record<string, unknown>;
    if (Object.keys(p).some(k => !['preferences', 'expectedRevision', 'acknowledgement', 'retentionAcknowledgement', 'exclusionAcknowledgement'].includes(k)) || !preferences(p.preferences) || !Number.isSafeInteger(p.expectedRevision)) throw new ContextMemoryError('invalid_context_settings');
    const now = date.getTime(); if (!Number.isFinite(now)) throw new ContextMemoryError('invalid_context_settings');
    const j = this.read(now), next = copy(p.preferences);
    if (p.expectedRevision !== j.revision) throw new ContextMemoryError('revision_changed', 409);
    if (next.pausedUntil && next.pausedUntil !== 'until-resumed' && (Date.parse(next.pausedUntil) <= now || Date.parse(next.pausedUntil) > now + DAY)) throw new ContextMemoryError('invalid_context_settings');
    if (next.enabled && (!j.prefs.enabled || next.sources.some(s => !j.prefs.sources.includes(s))) && p.acknowledgement !== CONSENT) throw new ContextMemoryError('context_consent_required', 403);
    if (next.retentionDays < j.prefs.retentionDays && p.retentionAcknowledgement !== 'shorten-context-retention-v1') throw new ContextMemoryError('retention_confirmation_required', 403);
    this.withLock(p.expectedRevision as number, now, latest => {
      if (next.retentionDays < latest.prefs.retentionDays && p.retentionAcknowledgement !== 'shorten-context-retention-v1') throw new ContextMemoryError('retention_confirmation_required', 403);
      if (next.enabled && (!latest.prefs.enabled || next.sources.some(s => !latest.prefs.sources.includes(s))) && p.acknowledgement !== CONSENT) throw new ContextMemoryError('context_consent_required', 403);
      const addedExclusions = next.excludedHosts.filter(h => !latest.prefs.excludedHosts.includes(h));
      if (addedExclusions.some(h => latest.events.some(e => blocked(e.url, [h])) || latest.bindings.some(b => blocked(b.url, [h]) || blocked(b.originURL, [h]))) && p.exclusionAcknowledgement !== 'exclude-context-site-v1') throw new ContextMemoryError('exclusion_confirmation_required', 403);
      if (latest.forgotten.length + addedExclusions.length > 1000) throw new ContextMemoryError('forget_limit', 409);
      latest.forgotten.push(...addedExclusions.map(h => ({ from: 0, to: now, host: h })));
      latest.prefs = next; latest.revision += 1;
      const cutoff = Math.max(latest.retainedAfter, now - next.retentionDays * DAY);
      latest.events = latest.events.filter(e => Date.parse(e.observedAt) >= cutoff && !blocked(e.url, next.excludedHosts)); latest.bindings = latest.bindings.filter(b => Date.parse(b.linkedAt) >= cutoff && !blocked(b.url, next.excludedHosts) && !blocked(b.originURL, next.excludedHosts)); latest.retainedAfter = cutoff;
      this.write(latest);
    });
    return this.status(date);
  }
  document(taskId: string, date = new Date()): DocumentView {
    if (typeof taskId !== 'string' || !/^[\w:.-]{1,140}$/.test(taskId) || !Number.isFinite(date.getTime())) throw new ContextMemoryError('invalid_document_link');
    this.expire(date.getTime()); const j = this.read(date.getTime());
    return { taskId, revision: j.revision, enabled: j.prefs.enabled && j.prefs.sources.includes('work-trail') && !paused(j.prefs, date.getTime()), binding: copy(j.bindings.find(b => b.taskId === taskId) ?? null) };
  }
  /** An owner confirms a metadata relationship. No document is fetched or opened. */
  linkDocument(input: unknown, task: RawItem | null, date = new Date()): DocumentView {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContextMemoryError('invalid_document_link');
    const p = input as Record<string, unknown>, now = date.getTime();
    if (Object.keys(p).length !== 4 || Object.keys(p).some(k => !['taskId', 'url', 'expectedRevision', 'confirmation'].includes(k)) || typeof p.taskId !== 'string' || !/^[\w:.-]{1,140}$/.test(p.taskId) || !Number.isSafeInteger(p.expectedRevision) || !Number.isFinite(now) || p.confirmation !== (p.url === null ? 'unlink-document-context' : 'link-document-metadata')) throw new ContextMemoryError('invalid_document_link');
    const doc = p.url === null ? null : canonicalDocument(p.url);
    if (p.url !== null && (!doc || !task || task.id !== p.taskId || !['schoology', 'manual', 'project'].includes(task.source) || task.flag || task.taint)) throw new ContextMemoryError('invalid_document_link');
    const j = this.read(now); if (j.revision !== p.expectedRevision) throw new ContextMemoryError('revision_changed', 409);
    this.withLock(j.revision, now, latest => {
      if (doc && (!latest.prefs.enabled || !latest.prefs.sources.includes('work-trail') || paused(latest.prefs, now))) throw new ContextMemoryError('context_source_required', 403);
      if (doc && (blocked(doc.url, latest.prefs.excludedHosts) || blocked(task!.url, latest.prefs.excludedHosts))) throw new ContextMemoryError('context_source_required', 403);
      if (doc && latest.bindings.some(b => b.sourceId === doc.sourceId && b.taskId !== p.taskId)) throw new ContextMemoryError('document_already_linked', 409);
      const old = latest.bindings.find(b => b.taskId === p.taskId);
      if (doc && !old && latest.bindings.length >= 50) throw new ContextMemoryError('document_limit', 409);
      if (old && (!doc || old.sourceId !== doc.sourceId)) {
        if (latest.forgotten.length >= 1000) throw new ContextMemoryError('forget_limit', 409);
        const fence: ForgetRule = { from: 0, to: now, source: 'work-trail', taskId: old.taskId, sourceId: old.sourceId };
        latest.forgotten.push(fence); latest.events = latest.events.filter(e => !inRule(e, fence));
      }
      latest.bindings = latest.bindings.filter(b => b.taskId !== p.taskId);
      if (doc) latest.bindings.push({ taskId: p.taskId as string, title: clean(task!.title, 180), space: task!.source === 'schoology' || task!.space === 'school' ? 'school' : 'personal', sourceId: doc.sourceId, url: doc.url, originURL: canonicalURL(task!.url), linkedAt: date.toISOString() });
      latest.revision += 1; this.write(latest);
    });
    return this.document(p.taskId, date);
  }
  /** Expected revision fences records obtained before a pause/forget/source change. */
  project(raws: readonly RawItem[], trail: readonly TrailEntry[], expectedRevision: number, date = new Date()): LocalContext | null {
    const now = date.getTime(); if (!Number.isFinite(now)) return null;
    const j = this.read(now);
    if (j.revision !== expectedRevision || !j.prefs.enabled || paused(j.prefs, now)) return null;
    return this.withLock(expectedRevision, now, j => {
    if (!j.prefs.enabled || paused(j.prefs, now)) return null;
    const taskIds = new Set<string>();
    const selected = raws.filter(r => { if (!r || !['schoology', 'manual', 'project'].includes(r.source) || r.flag || r.taint || blocked(r.url, j.prefs.excludedHosts) || taskIds.has(r.id)) return false; taskIds.add(r.id); return true; });
    const source = j.prefs.sources.includes('schoology') ? buildLocalContext({ version: 1, enabled: true, sources: ['schoology'] }, selected, [], date) : null;
    const activityRaws = selected.map(r => { const b = j.bindings.find(b => b.taskId === r.id && !blocked(b.url, j.prefs.excludedHosts)); return b ? { ...r, url: b.url } : r; });
    const claims = new Map<string, Set<string>>();
    for (const r of activityRaws) { const doc = canonicalDocument(r.url); if (doc) { const tasks = claims.get(doc.sourceId) ?? new Set<string>(); tasks.add(r.id); claims.set(doc.sourceId, tasks); } }
    const unambiguous = activityRaws.filter(r => { const doc = canonicalDocument(r.url); return !doc || claims.get(doc.sourceId)?.size === 1; });
    const activity = j.prefs.sources.includes('work-trail') ? buildLocalContext({ version: 1, enabled: true, sources: ['work-trail'] }, unambiguous, trail, date) : null;
    const combined = selected.flatMap(raw => [...(source?.records.filter(r => r.taskId === raw.id) ?? []), ...(activity?.records.filter(r => r.taskId === raw.id) ?? [])]);
    const projection: LocalContext = { version: 1, sources: [...j.prefs.sources], records: combined.slice(0, 200), truncated: combined.length > 200 || !!source?.truncated || !!activity?.truncated };
    const activityURLs = new Map(activityRaws.map(r => [r.id, r.url]));
    const tasks = new Map(selected.map(r => [r.id, r]));
    const activityOwners = new Map<string, Set<string>>();
    for (const r of projection.records.filter(r => r.source === 'work-trail')) { const owners = activityOwners.get(r.sourceId) ?? new Set<string>(); owners.add(r.taskId); activityOwners.set(r.sourceId, owners); }
    const existing = new Set(j.events.map(e => e.id)); let changed = false;
    const cutoff = Math.max(j.retainedAfter, now - j.prefs.retentionDays * DAY);
    for (const r of projection.records) {
      const raw = tasks.get(r.taskId);
      if (!raw || !r.observedAt || r.freshness !== 'fresh' || Date.parse(r.observedAt) < cutoff || Date.parse(r.observedAt) > now || (r.source === 'work-trail' && activityOwners.get(r.sourceId)!.size !== 1)) continue;
      const id = createHash('sha256').update(JSON.stringify([r.taskId, r.source, r.sourceId, r.kind, r.observedAt, r.value ?? null])).digest('hex').slice(0, 32);
      const event: MemoryEvent = { ...r, id, title: clean(raw.title, 180), url: canonicalURL(r.source === 'work-trail' ? activityURLs.get(raw.id) ?? raw.url : raw.url), space: raw.source === 'schoology' || raw.space === 'school' ? 'school' : 'personal', observedAt: r.observedAt };
      if (!validEvent(event) || existing.has(id) || j.forgotten.some(rule => inRule(event, rule))) continue;
      j.events.push(event); existing.add(id); changed = true;
    }
    if (j.events.length > MAX_EVENTS) { j.events.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.id.localeCompare(b.id)); j.events = j.events.slice(0, MAX_EVENTS); j.retainedAfter = Math.max(j.retainedAfter, Date.parse(j.events.at(-1)!.observedAt) + 1); j.events = j.events.filter(e => Date.parse(e.observedAt) >= j.retainedAfter); j.capped = true; changed = true; }
    if (changed) this.write(j);
    const current = projection.records.filter(r => (r.source !== 'work-trail' || activityOwners.get(r.sourceId)!.size === 1) && (r.observedAt === null || Date.parse(r.observedAt) >= j.retainedAfter) && !j.forgotten.some(rule => r.observedAt ? inRule({ ...r, observedAt: r.observedAt } as MemoryEvent, rule) : (!rule.source || rule.source === r.source) && (!rule.taskId || rule.taskId === r.taskId)));
    return { ...projection, records: current, revision: j.revision };
    });
  }
  history(opts: { space?: MemorySpace; day?: string; q?: string; source?: ContextSource; offset?: number; limit?: number; window?: 'ten-minutes' | 'six-hours' } = {}, date = new Date()): MemoryHistory {
    if (Object.keys(opts).some(k => !['space', 'day', 'q', 'source', 'offset', 'limit', 'window'].includes(k)) || (opts.space !== undefined && !['school', 'personal'].includes(opts.space)) || (opts.source !== undefined && !SOURCES.includes(opts.source)) || (opts.day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.day)) || (opts.q !== undefined && (typeof opts.q !== 'string' || opts.q.length > 200))
      || (opts.offset !== undefined && (!Number.isInteger(opts.offset) || opts.offset < 0 || opts.offset > MAX_EVENTS)) || (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 100)) || (opts.window !== undefined && !['ten-minutes', 'six-hours'].includes(opts.window))) throw new ContextMemoryError('invalid_context_query');
    const now = date.getTime(); if (!Number.isFinite(now)) throw new ContextMemoryError('invalid_context_query');
    this.expire(now);
    const j = this.read(now), q = clean(opts.q ?? '', 200).toLowerCase();
    const terms = q.normalize('NFKD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu)?.filter(t => !['what', 'did', 'i', 'the', 'a', 'an', 'on', 'was', 'have', 'been', 'work', 'worked', 'today', 'yesterday'].includes(t)) ?? [];
    const day = opts.day ?? (/\byesterday\b/.test(q) ? dayKey(now - DAY) : /\btoday\b/.test(q) ? dayKey(now) : undefined);
    const score = (e: MemoryEvent) => { const text = (e.title + ' ' + e.source + ' ' + (e.value ?? '') + ' ' + host(e.url)).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase(); return terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0); };
    const events = j.events.filter(e => e.space === (opts.space ?? 'school') && (!day || dayKey(Date.parse(e.observedAt)) === day) && (!opts.source || opts.source === e.source) && !blocked(e.url, j.prefs.excludedHosts) && (!terms.length || score(e) > 0)).map(e => ({ ...e, freshness: fresh(e, now) }))
      .sort((a, b) => (terms.length ? score(b) - score(a) : 0) || Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.id.localeCompare(b.id));
    const offset = opts.offset ?? 0, limit = opts.limit ?? 40, page = events.slice(offset, offset + limit);
    return { revision: j.revision, events: page, windows: condense(page, opts.window === 'six-hours' ? 6 * 3_600_000 : 600_000), total: events.length, more: offset + page.length < events.length, queryKind: terms.length ? 'lexical' : 'chronological' };
  }
  forget(target: unknown, expectedRevision: number, date = new Date()): MemoryStatus {
    const now = date.getTime(); if (!Number.isFinite(now)) throw new ContextMemoryError('invalid_forget_target');
    const j = this.read(now);
    if (expectedRevision !== j.revision) throw new ContextMemoryError('revision_changed', 409);
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new ContextMemoryError('invalid_forget_target');
    const t = target as Record<string, unknown>; if (Object.keys(t).some(k => !['kind', 'source', 'taskId'].includes(k))) throw new ContextMemoryError('invalid_forget_target');
    const rule: ForgetRule = { from: 0, to: now };
    switch (t.kind) {
      case 'all': if (Object.keys(t).length !== 1) throw new ContextMemoryError('invalid_forget_target'); break;
      case 'ten-minutes': rule.from = now - 600_000; break;
      case 'hour': rule.from = now - 3_600_000; break;
      case 'today': rule.from = dayStart(now); break;
      case 'source': if (!SOURCES.includes(t.source as ContextSource) || Object.keys(t).length !== 2) throw new ContextMemoryError('invalid_forget_target'); rule.source = t.source as ContextSource; break;
      case 'item': if (typeof t.taskId !== 'string' || !/^[\w:.-]{1,140}$/.test(t.taskId) || Object.keys(t).length !== 2) throw new ContextMemoryError('invalid_forget_target'); rule.taskId = t.taskId; break;
      default: throw new ContextMemoryError('invalid_forget_target');
    }
    if (!['all', 'source', 'item'].includes(t.kind as string) && Object.keys(t).length !== 1) throw new ContextMemoryError('invalid_forget_target');
    this.withLock(expectedRevision, now, latest => {
      if (t.kind === 'all') { rule.to = Math.max(rule.to, ...latest.events.map(e => Date.parse(e.observedAt)), ...latest.bindings.map(b => Date.parse(b.linkedAt))); latest.forgotten = [rule]; }
      else { if (latest.forgotten.length >= 1000) throw new ContextMemoryError('forget_limit', 409); latest.forgotten.push(rule); }
      latest.events = t.kind === 'all' ? [] : latest.events.filter(e => !inRule(e, rule)); latest.bindings = t.kind === 'all' ? [] : latest.bindings.filter(b => !inRule({ observedAt: b.linkedAt, source: 'work-trail', taskId: b.taskId, sourceId: b.sourceId, url: b.url } as MemoryEvent, rule)); latest.revision += 1;
      this.write(latest);
    });
    return this.status(date);
  }
}

/** Summaries are factual views, never persisted model paraphrases or hidden indexes. */
export function condense(events: readonly MemoryEvent[], width = 600_000): MemoryWindow[] {
  const buckets = new Map<number, MemoryEvent[]>();
  for (const e of events) { const at = Math.floor(Date.parse(e.observedAt) / width) * width; const bucket = buckets.get(at) ?? []; bucket.push(e); buckets.set(at, bucket); }
  return [...buckets].sort(([a], [b]) => b - a).map(([from, evidence]) => {
    const latest = new Map<string, MemoryEvent>();
    for (const e of [...evidence].sort((a, b) => a.observedAt.localeCompare(b.observedAt))) latest.set(e.source + ':' + e.sourceId, e);
    const facts = [...latest.values()], checked = facts.filter(e => e.source === 'schoology'), complete = checked.filter(e => e.value === 'reported-complete').length;
    const activity = facts.filter(e => e.source === 'work-trail');
    const names = [...new Set(facts.map(e => e.title))];
    const pieces = [checked.length ? `${checked.length} task${checked.length === 1 ? '' : 's'} checked, ${complete} reported complete.` : '', activity.length ? `${new Set(activity.map(e => e.sourceId)).size} matching page${new Set(activity.map(e => e.sourceId)).size === 1 ? '' : 's'} visited. Not proof of completion.` : ''].filter(Boolean);
    return { id: 'window:' + from, from: new Date(from).toISOString(), to: new Date(from + width).toISOString(), title: names.length === 1 ? names[0] : `${names.length} tasks in this window`, summary: pieces.join(' '), evidence: copy(evidence) };
  });
}
