/**
 * Full session history, read from messages.jsonl on disk.
 *
 * Why not the facade: `aside.sessions.messages(id)` returns the agent's
 * CURRENT CONTEXT, not the conversation. On a long or compacted session it
 * starts mid-conversation -- verified on a long live session, where the
 * facade hands back 50 messages beginning with a `system-message` while the
 * transcript on disk holds 300 lines and four separate user turns. Built
 * from the facade, that session collapses into one bare work fold with no
 * user bubble and no answers.
 *
 * The jsonl carries the same record shape the facade emits (`role`,
 * `content`, `timestamp`, `toolCallId`, `toolName`, `details`, `isError`),
 * so the thread builder consumes either. The differences this module
 * normalises away:
 *
 *  - Timestamps are seconds on disk and ms in places; both are coerced to ms.
 *  - `content` is a bare STRING on user messages written by the CLI, and a
 *    part array on assistant messages.
 *  - `user-message-metadata` is a separate record that PRECEDES the user
 *    message it belongs to and carries that message's attachments. It is
 *    folded onto the following user message rather than surfaced as a row.
 *  - `system-message` is skipped, exactly as the browser skips it.
 */
import fs from 'node:fs';
import type { FacadeMessage } from './facade.js';

/** A file the user attached to a message, as the transcript records it. */
export interface MessageAttachment {
  name: string;
  mimeType?: string;
}

export interface HistoryMessage extends FacadeMessage {
  /** Present on user messages that carried attachments. */
  attachments?: MessageAttachment[];
  /** Assistant token accounting: `totalTokens`, `output`, `reasoning`, … */
  usage?: Record<string, unknown>;
  /**
   * Why the assistant stopped. `"error"` is the one value that matters
   * here: it marks a turn the provider refused or dropped.
   */
  stopReason?: string;
  /**
   * The provider's own failure message, present on `stopReason: "error"`
   * records.
   *
   * This is where a rate limit, an expired sign-in or a timeout actually
   * lives -- verified against real transcripts, e.g. `{"role":"assistant",
   * "stopReason":"error","errorMessage":"429 status code (no body)",
   * "content":[]}`. Note the empty `content`: nothing else on the record
   * says anything went wrong, so a builder that only reads `content`
   * renders the turn as a blank response. That is exactly the bug this
   * field exists to fix.
   */
  errorMessage?: string;
}

/** Aside writes timestamps in seconds on some records and ms on others. */
export function normalizeTimestamp(raw: unknown): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? n : Math.round(n * 1000);
}

function readAttachments(raw: unknown): MessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String((item as any).name || '').trim();
    if (!name) continue;
    out.push({
      name,
      mimeType: (item as any).mimeType
        ? String((item as any).mimeType)
        : undefined,
    });
  }
  return out;
}

/**
 * Inline images larger than this are replaced by a marker before a line is
 * parsed. The thread never shows one (thread.ts drops anything over
 * MAX_IMAGE_BYTES, and keeps only 256KB of images per thread), so carrying
 * the bytes through JSON.parse only to discard them was pure cost: on the
 * owner's screenshot-heavy sessions 69MB of a 79MB transcript was base64
 * that no reader would ever see. Kept equal to MAX_IMAGE_BYTES.
 */
export const OMIT_IMAGE_CHARS = 256 * 1024;

/**
 * Replace oversized base64 `data` strings with an empty string and an
 * `omitted` flag, without parsing the line.
 *
 * The character class excludes quotes and backslashes, so a match can only
 * ever span one JSON string value: base64 has neither, and any string that
 * does is left alone. Lines too short to hold such a value skip the regex.
 */
const OVERSIZED_DATA_RE = new RegExp(
  `"data"\\s*:\\s*"[A-Za-z0-9+/=_-]{${OMIT_IMAGE_CHARS + 1},}"`,
  'g',
);
export function stripOversizedData(line: string): string {
  if (line.length <= OMIT_IMAGE_CHARS) return line;
  return line.replace(OVERSIZED_DATA_RE, '"data":"","omitted":true');
}

/**
 * Parser state that crosses lines: attachments arrive on their own record
 * just BEFORE the user message they describe, so they are held until that
 * message shows up.
 */
interface ParseState {
  pendingAttachments: MessageAttachment[];
}

/** One transcript line to zero or one history message. */
function parseLine(raw: string, state: ParseState, stripped = false): HistoryMessage | null {
  const line = raw.trim();
  if (!line) return null;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(stripped ? line : stripOversizedData(line)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const role = String(msg.role || '');
  if (!role) return null;

  if (role === 'user-message-metadata') {
    const found = readAttachments(msg.attachments);
    if (found.length) state.pendingAttachments = found;
    return null;
  }

  // The browser hides system messages; so do we. They are injected
  // context (skill hints, and similar), not conversation.
  if (role === 'system-message') return null;

  const entry: HistoryMessage = {
    role,
    content: msg.content,
    timestamp: normalizeTimestamp(msg.timestamp),
  };
  if (typeof msg.model === 'string') entry.model = msg.model;
  if (typeof msg.provider === 'string') entry.provider = msg.provider;
  if (typeof msg.toolCallId === 'string') entry.toolCallId = msg.toolCallId;
  if (typeof msg.toolName === 'string') entry.toolName = msg.toolName;
  if (msg.details && typeof msg.details === 'object') {
    entry.details = msg.details as Record<string, unknown>;
  }
  if (msg.usage && typeof msg.usage === 'object') {
    entry.usage = msg.usage as Record<string, unknown>;
  }
  if (typeof msg.stopReason === 'string') entry.stopReason = msg.stopReason;
  if (typeof msg.errorMessage === 'string') {
    entry.errorMessage = msg.errorMessage;
  }
  if (msg.isError) entry.isError = true;

  if (role === 'user' && state.pendingAttachments.length) {
    entry.attachments = state.pendingAttachments;
    state.pendingAttachments = [];
  }

  return entry;
}

/**
 * Parse a whole transcript buffer into the message list the thread builder
 * consumes. Corrupt lines are skipped, as they are everywhere else here.
 */
export function parseHistory(buffer: string): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  const state: ParseState = { pendingAttachments: [] };
  for (const raw of String(buffer || '').split('\n')) {
    const entry = parseLine(raw, state);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Most parsed text one transcript may hold in memory, AFTER oversized images
 * are stripped (see OMIT_IMAGE_CHARS).
 *
 * This used to be a cap on the FILE, and a transcript past it read as empty:
 * the thread route and every WebSocket push returned no items at all, so a
 * long screenshot-heavy session showed nothing on the phone while it ran.
 * The file size was the wrong measure -- nearly all of it was image bytes
 * that are now dropped before parsing. What the cap protects (a process
 * meant to run for weeks) is bounded here instead by what is retained; a
 * transcript past it keeps its newest messages rather than none.
 */
export const MAX_HISTORY_BYTES = 32 * 1024 * 1024;

/** A single line past this is skipped unread rather than allocated. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 4096;
/** Parsed transcripts kept for incremental reads. */
const MAX_CACHED_HISTORIES = 8;

/**
 * A transcript parsed up to its last complete line.
 *
 * Transcripts are append-only, and the hot caller (a WebSocket push on every
 * write, throttled to 80ms) used to re-read and re-parse the whole file each
 * time: 100-300ms of blocking work per push on the owner's 20-80MB sessions,
 * which starved every other request while a long task ran. Now only the
 * bytes appended since the last read are parsed. Identity (inode, device,
 * the first 4KB) is checked on every read, so a rewritten or truncated file
 * is parsed from scratch instead of being appended to.
 */
interface HistoryCacheEntry {
  ino: number;
  dev: number;
  head: Buffer;
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last newline consumed. */
  offset: number;
  messages: HistoryMessage[];
  state: ParseState;
  /** Parsed trailing line with no newline yet, if it parsed. */
  tail: HistoryMessage | null;
  /** Approximate characters retained, for MAX_HISTORY_BYTES. */
  retained: number;
  /** Retained length of each message, parallel to `messages`. */
  weights: number[];
}

const historyCache = new Map<string, HistoryCacheEntry>();

/** Test hook: forget every cached parse. */
export function clearHistoryCache(): void {
  historyCache.clear();
}

function readRange(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, start + done);
    if (n <= 0) break;
    done += n;
  }
  return done === length ? buf : buf.subarray(0, done);
}

function pushMessage(entry: HistoryCacheEntry, msg: HistoryMessage, weight: number, maxBytes: number): void {
  entry.messages.push(msg);
  entry.weights.push(weight);
  entry.retained += weight;
  if (entry.retained <= maxBytes) return;
  // Over budget: shed the oldest messages. Keeping the newest is what a
  // reader of a running task needs; an empty thread is what they got before.
  let drop = 0;
  while (entry.retained > maxBytes && drop < entry.messages.length - 1) {
    entry.retained -= entry.weights[drop];
    drop += 1;
  }
  entry.messages.splice(0, drop);
  entry.weights.splice(0, drop);
}

/** Parse everything appended since `entry.offset`, up to `size`. */
function consume(fd: number, entry: HistoryCacheEntry, size: number, maxBytes: number): void {
  let pos = entry.offset;
  let carry: Buffer[] = [];
  let carryLen = 0;
  let skipping = false;
  let lineStart = entry.offset;
  while (pos < size) {
    const chunk = readRange(fd, pos, Math.min(READ_CHUNK_BYTES, size - pos));
    if (!chunk.length) break;
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(10, from);
      if (nl === -1) break;
      if (!skipping) {
        const piece = chunk.subarray(from, nl);
        const bytes = carryLen ? Buffer.concat([...carry, piece]) : piece;
        const text = stripOversizedData(bytes.toString('utf8'));
        const msg = parseLine(text, entry.state, true);
        if (msg) pushMessage(entry, msg, text.length, maxBytes);
      }
      carry = [];
      carryLen = 0;
      skipping = false;
      from = nl + 1;
      lineStart = pos + from;
    }
    const rest = chunk.subarray(from);
    if (rest.length && !skipping) {
      carry.push(Buffer.from(rest));
      carryLen += rest.length;
      if (carryLen > MAX_LINE_BYTES) {
        carry = [];
        carryLen = 0;
        skipping = true;
      }
    }
    pos += chunk.length;
  }
  entry.offset = lineStart;
  // The last line may still be being written. Parse it provisionally on a
  // copy of the state; it is re-read until its newline lands.
  entry.tail = null;
  if (carryLen && !skipping) {
    const scratch: ParseState = { pendingAttachments: [...entry.state.pendingAttachments] };
    entry.tail = parseLine(Buffer.concat(carry).toString('utf8'), scratch);
  }
}

function snapshotOf(entry: HistoryCacheEntry): HistoryMessage[] {
  return entry.tail ? [...entry.messages, entry.tail] : entry.messages.slice();
}

/**
 * Read and parse a session transcript. Missing/unreadable reads as empty.
 *
 * Incremental and image-light; see HistoryCacheEntry and OMIT_IMAGE_CHARS.
 * The returned array is the caller's own, but the message objects in it are
 * shared with the cache and must be treated as read-only.
 */
export function readHistory(
  msgFile: string,
  maxBytes = MAX_HISTORY_BYTES,
): HistoryMessage[] {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(msgFile, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }
  if (!stat?.isFile()) {
    historyCache.delete(msgFile);
    return [];
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(msgFile, 'r');
    let entry = historyCache.get(msgFile);
    if (entry) {
      const sameFile =
        entry.ino === stat.ino &&
        entry.dev === stat.dev &&
        stat.size >= entry.size &&
        readRange(fd, 0, entry.head.length).equals(entry.head);
      if (!sameFile) entry = undefined;
    }
    if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
      historyCache.delete(msgFile);
      historyCache.set(msgFile, entry);
      return snapshotOf(entry);
    }
    if (!entry) {
      entry = {
        ino: stat.ino,
        dev: stat.dev,
        head: Buffer.alloc(0),
        size: 0,
        mtimeMs: 0,
        offset: 0,
        messages: [],
        state: { pendingAttachments: [] },
        tail: null,
        retained: 0,
        weights: [],
      };
    }
    consume(fd, entry, stat.size, maxBytes);
    entry.size = stat.size;
    entry.mtimeMs = stat.mtimeMs;
    if (entry.head.length < HEAD_BYTES) {
      entry.head = readRange(fd, 0, Math.min(HEAD_BYTES, stat.size));
    }
    historyCache.delete(msgFile);
    historyCache.set(msgFile, entry);
    while (historyCache.size > MAX_CACHED_HISTORIES) {
      const oldest = historyCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      historyCache.delete(oldest);
    }
    return snapshotOf(entry);
  } catch {
    historyCache.delete(msgFile);
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}
