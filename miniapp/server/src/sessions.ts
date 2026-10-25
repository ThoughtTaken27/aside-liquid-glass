/**
 * Session discovery over ~/.aside/u/0/sessions.
 *
 * Directories are named `<date>_<sessionId>`; the CLI takes the trailing
 * short id, so that is the id this API speaks. Resolution is done by
 * scanning for a directory ending in `_<id>` (bridge.py's rule), which is
 * also why no caller-supplied string can ever escape the sessions root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { collapseWhitespace, stripMarkdown, truncate } from './transcript.js';
import { fetchSessions, type FacadeCache, type FacadeSession } from './facade.js';
import type { StateSessionRow } from './statedb.js';
import { splitAttachmentHeader } from './uploads.js';
import { isMobileSeededText, stripAgentDirectives } from './preamble.js';
import { stripOversizedData } from './jsonl.js';

export interface SessionSummary {
  id: string;
  date: string;
  /** Directory mtime in ms -- last activity. */
  mtime: number;
  title: string;
  preview: string;
  turns: number;
  lastTotalTokens: number;
  totalCost: number;
}

/**
 * A session row as the UI draws it.
 *
 * Deliberately absent: ids, costs, token counts, turn counts. The Aside
 * sidepanel shows none of those and neither does this.
 */
export interface SessionRow {
  /** Needed for routing, never rendered. */
  id: string;
  title: string;
  preview: string;
  status: 'running' | 'idle' | 'errored' | string;
  /** Last activity, ms since epoch -- drives "13 hours ago". */
  updatedAt: number;
  createdAt: number;
  /** readAt < updatedAt means the browser would show an unread dot. */
  unread: boolean;
  trigger?: string;
  /**
   * Suspended on a native question tool, or sitting on an answerable
   * soft-marker question nobody has tapped yet. Filled in by the route,
   * not by `listSessionRows` itself -- it needs `notifier`'s tracked
   * state, which lives in app.ts alongside the WS's turn hooks (plan 6.4).
   */
  waiting?: boolean;
}

/** Session ids are opaque CLI tokens; anything else is not a session id. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

interface SessionDirectorySnapshot {
  checkedAt: number;
  mtimeMs: number;
  dirs: Map<string, string>;
}

/**
 * Short-lived index from Aside's opaque session id to its dated directory.
 *
 * A home refresh resolves up to 100 rows twice: once for title/preview and
 * once for liveness. Re-reading a directory with thousands of sessions for
 * every id made that route spend about half a second on repeated scans.
 */
export class SessionDirectoryIndex {
  private readonly roots = new Map<string, SessionDirectorySnapshot>();

  constructor(
    private readonly ttlMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  resolve(sessionsDir: string, sessionId: string): string | null {
    if (!isValidSessionId(sessionId)) return null;
    const snapshot = this.snapshot(sessionsDir);
    return snapshot.dirs.get(sessionId) ?? null;
  }

  private snapshot(sessionsDir: string): SessionDirectorySnapshot {
    const now = this.now();
    const hit = this.roots.get(sessionsDir);
    if (hit && now - hit.checkedAt < this.ttlMs) return hit;

    const rootStat = fs.statSync(sessionsDir, { throwIfNoEntry: false });
    if (hit && rootStat?.isDirectory() && rootStat.mtimeMs === hit.mtimeMs) {
      hit.checkedAt = now;
      this.touch(sessionsDir, hit);
      return hit;
    }

    const dirs = new Map<string, string>();
    if (rootStat?.isDirectory()) {
      try {
        const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const cut = entry.name.lastIndexOf('_');
          if (cut < 0) continue;
          const id = entry.name.slice(cut + 1);
          if (!isValidSessionId(id) || dirs.has(id)) continue;
          const full = path.join(sessionsDir, entry.name);
          if (
            entry.isDirectory() ||
            fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()
          ) {
            dirs.set(id, full);
          }
        }
      } catch {
        // Missing or temporarily unreadable root is an empty snapshot.
      }
    }

    const next = {
      checkedAt: now,
      mtimeMs: rootStat?.mtimeMs ?? -1,
      dirs,
    };
    this.touch(sessionsDir, next);
    return next;
  }

  private touch(sessionsDir: string, snapshot: SessionDirectorySnapshot): void {
    this.roots.delete(sessionsDir);
    this.roots.set(sessionsDir, snapshot);
    while (this.roots.size > 8) {
      const oldest = this.roots.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.roots.delete(oldest);
    }
  }
}

const sessionDirectories = new SessionDirectoryIndex();

export function resolveSessionDir(
  sessionsDir: string,
  sessionId: string,
): string | null {
  return sessionDirectories.resolve(sessionsDir, sessionId);
}

export function sessionMsgFile(
  sessionsDir: string,
  sessionId: string,
): string | null {
  const dir = resolveSessionDir(sessionsDir, sessionId);
  return dir ? path.join(dir, 'messages.jsonl') : null;
}

/**
 * The persona seed bridge.py writes into every /new session looks
 * identical everywhere, so it never makes a useful title.
 */
const PERSONA_SEED_MARK = 'permanent telegram thread';

/** How much of a transcript is read looking for its first user message. */
const FIRST_MESSAGE_SCAN_BYTES = 64 * 1024;

/**
 * The first user message in a transcript, or "" when there is none.
 *
 * Reads a bounded prefix rather than the whole file: the first user row is
 * the first or second line of every transcript, and the owner's largest are
 * tens of megabytes.
 */
export function firstUserText(msgFile: string): string {
  let buffer = '';
  try {
    const fd = fs.openSync(msgFile, 'r');
    try {
      const chunk = Buffer.alloc(FIRST_MESSAGE_SCAN_BYTES);
      const read = fs.readSync(fd, chunk, 0, chunk.length, 0);
      buffer = chunk.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
  for (const raw of buffer.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // A truncated final line is expected -- the read is bounded.
      continue;
    }
    if (msg?.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return String(
        msg.content.find((p: any) => p?.type === 'text')?.text ?? '',
      );
    }
  }
  return '';
}

/**
 * Whether this session was started from a phone -- by this app or by
 * bridge.py.
 *
 * The discriminator is the seed text both surfaces write into the first
 * prompt, so it needs no store, survives a cleared state directory, and
 * cannot drift out of sync with the transcript it describes. See
 * `isMobileSeededText`.
 */
export function isMobileSession(
  sessionsDir: string,
  sessionId: string,
): boolean {
  const msgFile = sessionMsgFile(sessionsDir, sessionId);
  return msgFile ? isMobileSeededText(firstUserText(msgFile)) : false;
}

function titleFrom(text: string): string {
  // The attachment header is addressed to the agent, not the reader; a
  // title of "[user sent 2 files from their phone, saved to: /Users/…]" is
  // no title at all. Seen on a live run.
  //
  // Same for the mobile preamble and the follow-up reminder. The preamble
  // is prepended BEFORE the attachment header, so `splitAttachmentHeader`
  // alone never saw the header at all and every Mini App session titled
  // itself "[Aside Mini App session. You are running for a user on…".
  let snippet = splitAttachmentHeader(stripAgentDirectives(text)).text;
  const noteAt = snippet.toLowerCase().indexOf('[bridge note');
  if (noteAt > 0) snippet = snippet.slice(0, noteAt);
  return truncate(collapseWhitespace(snippet), 64);
}

interface ScanResult {
  title: string;
  preview: string;
  turns: number;
  lastTotalTokens: number;
  totalCost: number;
}

interface ScanState extends ScanResult { fallbackTitle: string }
const emptyScan = (): ScanState => ({ title: '', fallbackTitle: '', preview: '', turns: 0, lastTotalTokens: 0, totalCost: 0 });
const summaryOf = (s: ScanState): ScanResult => ({ title: s.title || s.fallbackTitle || '(no messages)', preview: s.preview, turns: s.turns, lastTotalTokens: s.lastTotalTokens, totalCost: s.totalCost });

function scanLine(state: ScanState, raw: string | Buffer): void {
  // Native records put role first. Skip tool screenshots without decoding
  // their multi-megabyte base64 strings. Other field orders still parse.
  const prefix = typeof raw === 'string' ? raw.substring(0, 128) : raw.subarray(0, 128).toString('utf8');
  const role = /^\s*\{\s*"role"\s*:\s*"([^"]+)"/.exec(prefix)?.[1];
  if (role && role !== 'user' && role !== 'assistant') return;
  let msg: any;
  try { msg = JSON.parse(stripOversizedData(typeof raw === 'string' ? raw : raw.toString('utf8'))); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.role === 'user') {
    state.turns++;
    const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? (msg.content.find((p: any) => p?.type === 'text')?.text ?? '') : '';
    if (!text) return;
    if (text.toLowerCase().includes(PERSONA_SEED_MARK)) { state.fallbackTitle ||= titleFrom(text); return; }
    state.title ||= titleFrom(text);
  } else if (msg.role === 'assistant') {
    const usage = msg.usage || {};
    if (usage.totalTokens) state.lastTotalTokens = Number(usage.totalTokens);
    state.totalCost += Number(usage?.cost?.total || 0);
    if (Array.isArray(msg.content)) for (const part of msg.content) {
      if (part?.type === 'text' && String(part.text || '').trim()) state.preview = truncate(collapseWhitespace(stripMarkdown(String(part.text))), 240);
    }
  }
}

/** Pure scan retained for callers/tests; same reducer as the live cache. */
export function scanTranscript(buffer: string): ScanResult {
  const state = emptyScan();
  for (const line of buffer.split('\n')) scanLine(state, line);
  return summaryOf(state);
}

interface CacheEntry {
  size: number; mtimeMs: number; ino: number; dev: number;
  head: Buffer; offset: number; state: ScanState;
  result: ScanResult;
}
const MAX_SCAN_CACHE = 300;
const scanCache = new Map<string, CacheEntry>();
/** Test hook. The live cache is bounded and retains only scalar summaries. */
export function clearScanCache(): void { scanCache.clear(); }
const SCAN_CHUNK = 512 * 1024;
const SCAN_MAX_LINE = 128 * 1024 * 1024;
function scanCached(msgFile: string, stat: fs.Stats): ScanResult {
  let fd: number | undefined;
  try {
    fd = fs.openSync(msgFile, 'r');
    const head = Buffer.alloc(Math.min(64, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    let entry = scanCache.get(msgFile);
    if (entry && (entry.ino !== stat.ino || entry.dev !== stat.dev || stat.size < entry.size || !head.subarray(0, entry.head.length).equals(entry.head) || (stat.size === entry.size && stat.mtimeMs !== entry.mtimeMs))) entry = undefined;
    if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
      scanCache.delete(msgFile); scanCache.set(msgFile, entry);
      return entry.result;
    }
    entry ??= { size: 0, mtimeMs: 0, ino: stat.ino, dev: stat.dev, head, offset: 0, state: emptyScan(), result: summaryOf(emptyScan()) };
    let pos = entry.offset, lineStart = pos, length = 0, skipping = false;
    let pieces: Buffer[] = [];
    while (pos < stat.size) {
      const chunk = Buffer.alloc(Math.min(SCAN_CHUNK, stat.size - pos));
      const read = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (!read) break;
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(10, from);
        if (nl < 0 || nl >= read) break;
        if (!skipping) scanLine(entry.state, length ? Buffer.concat([...pieces, chunk.subarray(from, nl)]) : chunk.subarray(from, nl));
        pieces = []; length = 0; skipping = false;
        from = nl + 1; lineStart = pos + from;
      }
      if (from < read && !skipping) {
        const rest = chunk.subarray(from, read);
        const role = !length ? /^\s*\{\s*"role"\s*:\s*"([^"]+)"/.exec(rest.subarray(0, 128).toString('utf8'))?.[1] : undefined;
        if (role && role !== 'user' && role !== 'assistant') {
          // Skip a multi-chunk tool row immediately; never hold its images.
          skipping = true;
        } else {
          pieces.push(Buffer.from(rest)); length += rest.length;
          if (length > SCAN_MAX_LINE) { pieces = []; length = 0; skipping = true; }
        }
      }
      pos += read;
    }
    entry.offset = lineStart;
    // Valid lines without a final newline are visible provisionally, but
    // never double-counted when the remaining bytes/newline arrive.
    const visible = { ...entry.state };
    if (length && !skipping) scanLine(visible, Buffer.concat(pieces));
    entry.result = summaryOf(visible);
    entry.size = stat.size; entry.mtimeMs = stat.mtimeMs; entry.head = head;
    scanCache.delete(msgFile); scanCache.set(msgFile, entry);
    while (scanCache.size > MAX_SCAN_CACHE) scanCache.delete(scanCache.keys().next().value!);
    return entry.result;
  } catch { scanCache.delete(msgFile); return summaryOf(emptyScan()); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * Newest sessions first. Only the `limit` most recent transcripts are read;
 * everything else is decided from directory metadata.
 */
export function listSessions(
  sessionsDir: string,
  limit = 30,
): SessionSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const rows: Array<{
    id: string;
    date: string;
    mtime: number;
    msgFile: string;
    stat: fs.Stats;
  }> = [];

  for (const name of names) {
    if (!name.includes('_')) continue;
    const dir = path.join(sessionsDir, name);
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const msgFile = path.join(dir, 'messages.jsonl');
    const stat = fs.statSync(msgFile, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    const cut = name.lastIndexOf('_');
    rows.push({
      id: name.slice(cut + 1),
      date: name.slice(0, cut),
      // The transcript's own mtime tracks activity more tightly than the
      // directory's, which also moves for artifacts and tmp files.
      mtime: Math.max(stat.mtimeMs, fs.statSync(dir).mtimeMs),
      msgFile,
      stat,
    });
  }

  rows.sort((a, b) => b.mtime - a.mtime);

  return rows.slice(0, Math.max(0, limit)).map((row) => ({
    id: row.id,
    date: row.date,
    mtime: row.mtime,
    ...scanCached(row.msgFile, row.stat),
  }));
}

/**
 * Title and preview for one session, read from its transcript.
 *
 * The preview is just the last assistant paragraph, identical on disk, so
 * reading it locally keeps the list cheap. The title matters more now: the
 * daemon stores a placeholder for CLI-created sessions (see
 * PLACEHOLDER_TITLES) and those are exactly the sessions this app itself
 * creates, so without a local derivation the list would be a column of
 * rows all reading "Aside CLI".
 */
function localScan(
  sessionsDir: string,
  id: string,
): { title: string; preview: string } {
  const dir = resolveSessionDir(sessionsDir, id);
  if (!dir) return { title: '', preview: '' };
  const msgFile = path.join(dir, 'messages.jsonl');
  const stat = fs.statSync(msgFile, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { title: '', preview: '' };
  const scanned = scanCached(msgFile, stat);
  return { title: scanned.title, preview: scanned.preview };
}

/**
 * Titles the daemon writes when it has none of its own. They are not
 * useful labels, so a transcript-derived title wins over them.
 */
const PLACEHOLDER_TITLES = new Set(['', 'aside cli', 'new session', 'untitled']);

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(String(title || '').trim().toLowerCase());
}

/**
 * A title derived from a session's own transcript.
 *
 * `localScan` already did this for the list, but privately. The thread
 * route needs the same answer for the same reason -- a session the daemon
 * has called "Aside CLI" should read the same in the header as it does in
 * the row above it -- so the derivation is exported rather than
 * reimplemented. Returns '' when there is nothing to derive from, which
 * the caller treats as "keep whatever the daemon said".
 */
export function titleFromTranscript(
  sessionsDir: string,
  id: string,
): string {
  return localScan(sessionsDir, id).title;
}

function timeOf(iso: string | undefined): number {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? t : 0;
}

function triggerType(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session list the UI renders.
 *
 * state.db is the primary source. The facade's `sessions.list()` returns
 * only what the browser sidepanel shows and drops every CLI-created
 * session -- 93 rows out of 179 on the owner's machine -- which is why
 * sessions started from the Telegram bridge, and from this app itself,
 * never appeared. See `StateDb.list` for the filter and its reasoning.
 *
 * Both remaining sources stay as fallbacks: the facade when the database
 * cannot be read (an older Node without node:sqlite, mainly), and a plain
 * directory scan when the facade is unreachable too. The app degrades to
 * the previous behaviour rather than to an empty screen.
 */
export async function listSessionRows(
  cache: FacadeCache,
  sessionsDir: string,
  limit = 100,
  stateDb?: { list: (limit?: number) => Promise<StateSessionRow[] | null> },
): Promise<{ rows: SessionRow[]; source: 'statedb' | 'facade' | 'filesystem' }> {
  const dbRows = stateDb ? await stateDb.list(limit).catch(() => null) : null;

  if (dbRows && dbRows.length) {
    const rows = dbRows.slice(0, limit).map((s) => {
      const local = localScan(sessionsDir, s.id);
      const title = isPlaceholderTitle(s.title) ? local.title : s.title;
      return {
        id: s.id,
        title: title || s.title || 'Untitled',
        preview: local.preview,
        status: s.status || 'idle',
        updatedAt: s.updatedAt || s.createdAt,
        createdAt: s.createdAt,
        unread: s.readAt < s.updatedAt,
        trigger: triggerType(s.trigger),
      };
    });
    return { rows, source: 'statedb' };
  }

  let facadeRows: FacadeSession[] = [];
  try {
    facadeRows = await fetchSessions(cache, limit);
  } catch {
    facadeRows = [];
  }

  if (facadeRows.length) {
    const rows = facadeRows
      .filter((s) => s && typeof s.id === 'string' && !s.incognito)
      .map((s) => {
        const updatedAt = timeOf(s.updatedAt) || timeOf(s.createdAt);
        const local = localScan(sessionsDir, s.id);
        const title = isPlaceholderTitle(s.title || '')
          ? local.title
          : (s.title || '').trim();
        return {
          id: s.id,
          title: title || 'Untitled',
          preview: local.preview,
          status: s.status || 'idle',
          updatedAt,
          createdAt: timeOf(s.createdAt),
          unread: timeOf(s.readAt) < updatedAt,
          trigger: s.trigger?.type,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { rows, source: 'facade' };
  }

  const rows = listSessions(sessionsDir, limit).map((s) => ({
    id: s.id,
    title: s.title,
    preview: s.preview,
    status: 'idle',
    updatedAt: s.mtime,
    createdAt: s.mtime,
    unread: false,
  }));
  return { rows, source: 'filesystem' };
}

/**
 * How long a just-created session may take to put a transcript on disk,
 * and how often to look. Shared with the WebSocket subscribe path so both
 * transports agree on what "not there yet" means.
 */
export const NEW_SESSION_WAIT_MS = 30_000;
export const NEW_SESSION_POLL_MS = 250;

/**
 * Resolve a session's transcript, waiting if it is still being created.
 *
 * `aside exec` hands back a session id as soon as its DIRECTORY appears;
 * messages.jsonl lands a moment later. The WebSocket already treated that
 * gap as a wait, but the REST `/thread` route answered 404 the instant the
 * file was missing -- so opening a brand new chat flashed
 * "404: session_not_found" for the fraction of a second before the file
 * appeared. Observed live: `POST /api/sessions/new` 200, then `/thread`
 * 404 two milliseconds later, then 200.
 *
 * Waiting is only justified while this server is itself mid-turn on that
 * id, which is exactly the just-created case -- `createSession` marks the
 * queue running before it returns. Any other unknown id still answers
 * immediately, so a typo or a stale link never hangs the client.
 */
export async function waitForTranscript(
  sessionsDir: string,
  id: string,
  isBusy: (id: string) => boolean,
  options: {
    waitMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<string | null> {
  const exists = () => {
    const file = sessionMsgFile(sessionsDir, id);
    return file && fs.existsSync(file) ? file : null;
  };

  const immediate = exists();
  if (immediate) return immediate;
  if (!isBusy(id)) return null;

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.waitMs ?? NEW_SESSION_WAIT_MS);
  const pollMs = options.pollMs ?? NEW_SESSION_POLL_MS;

  for (;;) {
    await sleep(pollMs);
    const found = exists();
    if (found) return found;
    // A turn that ended without ever writing a transcript failed outright;
    // there is nothing left to wait for.
    if (now() > deadline || !isBusy(id)) return null;
  }
}

/**
 * The agent's last plain-text reply at or after `sinceMs` (Sep 27), for the
 * task card and the "done" ping. Tool calls and thinking are skipped; the
 * reply is trimmed to `max` characters on a sentence edge where possible.
 */
export function lastReplyText(msgFile: string | null, sinceMs: number, max = 600): string | null {
  if (!msgFile) return null;
  let raw: string;
  try {
    const st = fs.statSync(msgFile);
    const fd = fs.openSync(msgFile, 'r');
    try {
      const len = Math.min(st.size, 400_000);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      raw = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  let out: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let m: { role?: string; timestamp?: number; content?: unknown };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.role !== 'assistant' || (m.timestamp ?? 0) < sinceMs || !Array.isArray(m.content)) continue;
    const text = (m.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('\n')
      .trim();
    if (text) out = text;
  }
  if (!out) return null;
  const clean = out.replace(/```[\s\S]*?```/g, '').replace(/[*_#>`]/g, '').replace(/\n{2,}/g, '\n').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const edge = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return (edge > max * 0.5 ? cut.slice(0, edge + 1) : cut).trim() + (edge > max * 0.5 ? '' : '…');
}
