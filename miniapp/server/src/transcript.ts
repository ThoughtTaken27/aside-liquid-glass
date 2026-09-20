/**
 * messages.jsonl parsing.
 *
 * Ported from bridge.py's `stream_new` / `TurnStream`, which is the
 * production-tested reading of Aside's transcript format. The rules that
 * matter and that are easy to get wrong:
 *
 *  - The transcript is the source of truth for replies, not CLI stdout.
 *  - A line is only safe to parse once it ends in "\n"; the last line of a
 *    live file is routinely a partial write.
 *  - A tool call's human label is `arguments.title`, falling back to the
 *    raw tool name.
 *  - Subagents are spawned under a toolCallId but later referenced only by
 *    task_id, which first appears in the spawn toolResult's
 *    `details.taskId`. Without re-keying, every `subagent_wait` result
 *    would look like an unknown agent.
 *  - `subagent_wait` results arrive as one blob containing one
 *    <subagent_result task_id="..."> block per finished subagent.
 */

import fs from 'node:fs';

export type TranscriptEntryKind =
  | 'user'
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'subagent';

interface BaseEntry {
  /** 0-based physical line offset in messages.jsonl -- the stable cursor. */
  line: number;
  /** Index of the content part within that line. */
  part: number;
  /** `${line}:${part}` -- stable across refetches, safe as a React key. */
  id: string;
  ts: number | null;
}

export interface UserEntry extends BaseEntry {
  kind: 'user';
  text: string;
}
export interface AssistantTextEntry extends BaseEntry {
  kind: 'assistant_text';
  text: string;
  model?: string;
}
export interface ThinkingEntry extends BaseEntry {
  kind: 'thinking';
  text: string;
}
export interface ToolCallEntry extends BaseEntry {
  kind: 'tool_call';
  toolCallId?: string;
  name: string;
  title: string;
}
export interface ToolResultEntry extends BaseEntry {
  kind: 'tool_result';
  toolCallId?: string;
  name: string;
  isError: boolean;
  preview: string;
}
export interface SubagentEntry extends BaseEntry {
  kind: 'subagent';
  event: 'spawn' | 'wait' | 'result';
  taskId?: string;
  callId?: string;
  desc: string;
  profile?: string;
  background?: boolean;
  text?: string;
  isError?: boolean;
}

export type TranscriptEntry =
  | UserEntry
  | AssistantTextEntry
  | ThinkingEntry
  | ToolCallEntry
  | ToolResultEntry
  | SubagentEntry;

const SUBAGENT_RESULT_RE =
  /<subagent_result task_id="([^"]+)">([\s\S]*?)<\/subagent_result>/g;

interface SubagentInfo {
  desc: string;
  profile: string;
  background: boolean;
  callId?: string;
  taskId?: string;
}

/** Aside writes timestamps in seconds on some records and ms on others. */
function normalizeTs(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : Math.round(n * 1000);
}

export function collapseWhitespace(text: string): string {
  return (text || '').split(/\s+/).filter(Boolean).join(' ');
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Flatten markdown to prose for the session-card preview.
 *
 * The preview is a plain one-line snippet, so leaving the source syntax in
 * shows the reader `**Opener**` and stray backticks where the sidepanel
 * shows formatted text. This strips the markers rather than rendering
 * them.
 */
export function stripMarkdown(text: string): string {
  return (text || '')
    // Citation markup is machine addressing, never prose. The reader of a
    // one-line preview should see the supporting sentence, not the tag
    // around it.
    .replace(/<\/?citation(?:\s+refs="[^"]*")?\s*>/g, '')
    .replace(/<\/?quote>/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/(\*\*\*|___)(.*?)\1/g, '$2')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(?<![\w*])[*_](?=\S)([^*_]+?)(?<=\S)[*_](?![\w*])/g, '$1')
    .replace(/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/gm, ' ');
}

/** Text out of a `content` field that may be a bare string or a part list. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && (part as any).type === 'text') {
      chunks.push(String((part as any).text || ''));
    }
  }
  return chunks.join('\n');
}

/**
 * Stateful line-by-line transcript parser. State is only the subagent
 * registry, which exists so task_id-only events can recover the
 * description recorded at spawn time.
 */
export class TranscriptParser {
  private subagents = new Map<string, SubagentInfo>();

  feedLine(raw: string, line: number): TranscriptEntry[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return []; // a corrupt line is skipped, exactly as bridge.py does
    }

    const ts = normalizeTs(msg.timestamp);
    const role = msg.role;
    const out: TranscriptEntry[] = [];
    const base = (part: number) => ({ line, part, id: `${line}:${part}`, ts });

    if (role === 'user') {
      const text = textOf(msg.content).trim();
      if (text) out.push({ ...base(0), kind: 'user', text });
      return out;
    }

    if (role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const model = typeof msg.model === 'string' ? msg.model : undefined;
      content.forEach((part: any, index: number) => {
        if (!part || typeof part !== 'object') return;
        if (part.type === 'text' && String(part.text || '').trim()) {
          out.push({
            ...base(index),
            kind: 'assistant_text',
            text: String(part.text),
            model,
          });
          return;
        }
        if (part.type === 'thinking' && String(part.thinking || '').trim()) {
          out.push({
            ...base(index),
            kind: 'thinking',
            text: String(part.thinking),
          });
          return;
        }
        if (part.type !== 'toolCall') return;

        const name = String(part.name || '');
        const args = (part.arguments || {}) as Record<string, unknown>;
        const callId = part.id ? String(part.id) : undefined;

        if (name === 'subagent' && args.action === 'spawn') {
          const desc =
            collapseWhitespace(
              String(args.description || args.prompt || '') || 'subagent',
            ) || 'subagent';
          const info: SubagentInfo = {
            desc,
            profile: String(args.subagent_profile || 'default'),
            background: Boolean(args.run_in_background),
            callId,
          };
          if (callId) this.subagents.set(callId, info);
          out.push({
            ...base(index),
            kind: 'subagent',
            event: 'spawn',
            callId,
            desc,
            profile: info.profile,
            background: info.background,
          });
          return;
        }

        if (name === 'subagent_wait') {
          const taskIds = Array.isArray(args.task_ids)
            ? (args.task_ids as unknown[]).map(String)
            : [];
          if (!taskIds.length) return;
          for (const taskId of taskIds) {
            out.push({
              ...base(index),
              id: `${line}:${index}:${taskId}`,
              kind: 'subagent',
              event: 'wait',
              taskId,
              desc: this.subagents.get(taskId)?.desc || taskId,
            });
          }
          return;
        }

        out.push({
          ...base(index),
          kind: 'tool_call',
          toolCallId: callId,
          name,
          title: collapseWhitespace(String(args.title || '') || name) || name,
        });
      });
      return out;
    }

    if (role === 'toolResult') {
      const toolName = String(msg.toolName || '');
      const toolCallId = msg.toolCallId ? String(msg.toolCallId) : undefined;
      const isError = Boolean(msg.isError);
      const text = textOf(msg.content);

      if (toolName === 'subagent') {
        // Re-key the spawn registry from toolCallId to the real task_id.
        const taskId = String(
          ((msg.details as Record<string, unknown>) || {}).taskId || '',
        );
        if (taskId && toolCallId) {
          const info = this.subagents.get(toolCallId);
          if (info) {
            info.taskId = taskId;
            this.subagents.set(taskId, info);
          }
        }
        return out;
      }

      if (toolName === 'subagent_wait') {
        SUBAGENT_RESULT_RE.lastIndex = 0;
        const matches = [...text.matchAll(SUBAGENT_RESULT_RE)];
        if (matches.length) {
          matches.forEach((match, index) => {
            const taskId = match[1];
            out.push({
              ...base(index),
              id: `${line}:${index}:${taskId}`,
              kind: 'subagent',
              event: 'result',
              taskId,
              desc: this.subagents.get(taskId)?.desc || taskId,
              text: match[2].trim(),
              isError,
            });
          });
        } else if (text.trim()) {
          const taskId = toolCallId || 'subagent';
          out.push({
            ...base(0),
            kind: 'subagent',
            event: 'result',
            taskId,
            desc: this.subagents.get(taskId)?.desc || taskId,
            text: text.trim(),
            isError,
          });
        }
        return out;
      }

      out.push({
        ...base(0),
        kind: 'tool_result',
        toolCallId,
        name: toolName,
        isError,
        preview: truncate(collapseWhitespace(text), 400),
      });
      return out;
    }

    // system-message / user-message-metadata and anything future: ignored.
    return out;
  }
}

/**
 * Split a transcript buffer into lines that are safe to parse.
 *
 * A live messages.jsonl usually ends mid-write, so the final unterminated
 * line is dropped -- unless it happens to be complete JSON already, which
 * covers the (rare) file saved without a trailing newline.
 */
export function completeLines(buffer: string): string[] {
  const lines = buffer.split('\n');
  const tail = lines.pop();
  if (tail === undefined || tail === '') return lines;
  try {
    JSON.parse(tail);
    lines.push(tail);
  } catch {
    // partial write still in flight -- it will show up on the next read
  }
  return lines;
}

/**
 * Parse a whole transcript buffer. Entries at or before `afterLine` are
 * still replayed (cheaply) so subagent descriptions resolve, then filtered
 * out of the result.
 */
export function parseTranscript(
  buffer: string,
  opts: { afterLine?: number } = {},
): { entries: TranscriptEntry[]; lastLine: number } {
  const afterLine = opts.afterLine ?? -1;
  const parser = new TranscriptParser();
  const lines = completeLines(buffer);

  const entries: TranscriptEntry[] = [];
  lines.forEach((raw, line) => {
    const produced = parser.feedLine(raw, line);
    if (line > afterLine) entries.push(...produced);
  });
  return { entries, lastLine: lines.length - 1 };
}

/**
 * How stale a transcript's last write may be and still count as live.
 *
 * A turn can sit between transcript writes for as long as one tool call
 * takes -- a slow subagent_wait, a long bash command -- so this is not "how
 * fast do we notice a stall", it is "how long after the LAST byte landed do
 * we stop believing the turn is still going". `watcher.ts` now emits on
 * every mtime change even without a complete new line, which keeps this
 * fresh for a long-running single tool call too.
 */
export const LIVE_TRANSCRIPT_WINDOW_MS = 30_000;

/**
 * Whether the transcript's tail record is an unfinished turn: an assistant
 * record whose last part is a `toolCall` with no matching `toolResult`
 * later in the file, or an assistant record with no terminal `stopReason`.
 *
 * This is the fallback liveness signal for a turn a DIFFERENT process
 * spawned -- most importantly a turn started from the Mac. `runner.isBusy`
 * only knows about turns this server itself spawned via `aside exec|
 * child_process, and the daemon's own `state.db` status column never
 * actually reaches `running` in practice (verified: 1,109 rows, zero
 * `running`). So a desktop-started turn has no other liveness signal at
 * all, and without this every phone view of it renders as a collapsed,
 * finished fold until the user taps in.
 *
 * Deliberately reads only the last few tool call / tool result records
 * rather than parsing the whole file: the question this answers is "is the
 * LAST thing in the file still open", and a transcript can be tens of
 * megabytes.
 */
export function tailIsUnfinishedTurn(buffer: string): boolean {
  const lines = completeLines(buffer);
  // Walk from the end. The only records that matter are the trailing
  // assistant/toolResult run; a user record ends the search because
  // anything before the last user turn is necessarily already finished.
  const openCallIds = new Set<string>();
  // Walking backward means a toolResult is always encountered BEFORE the
  // toolCall it answers (results are written after calls). So a call's id
  // can't simply be deleted-on-result then added-on-call -- the delete
  // would be a no-op that runs before the id ever exists, leaving every
  // resolved call looking permanently open. Track resolved ids separately
  // and only count a toolCall as open if its id was never resolved.
  const resolvedCallIds = new Set<string>();
  let sawTrailingAssistant = false;
  let trailingAssistantHasTerminalStop = false;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role = msg.role;

    if (role === 'user') {
      // Reached the start of the current turn without finding an open
      // tool call and without an unterminated assistant record: finished.
      break;
    }

    if (role === 'toolResult') {
      const id = typeof msg.toolCallId === 'string' ? msg.toolCallId : '';
      if (id) resolvedCallIds.add(id);
      continue;
    }

    if (role === 'assistant') {
      if (!sawTrailingAssistant) {
        sawTrailingAssistant = true;
        const stopReason = (msg as { stopReason?: unknown }).stopReason;
        // 'toolUse' is a terminal stop for the ASSISTANT RECORD itself --
        // the turn continues, but only if the tool call it just emitted
        // has no matching result yet, which the toolCall scan below
        // decides. Anything else terminal (stop / error / length /
        // aborted) closes the record outright.
        trailingAssistantHasTerminalStop =
          typeof stopReason === 'string' &&
          stopReason !== 'toolUse' &&
          stopReason.length > 0;
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if ((part as { type?: unknown }).type !== 'toolCall') continue;
        const id = (part as { id?: unknown }).id;
        if (typeof id === 'string' && id && !resolvedCallIds.has(id)) {
          openCallIds.add(id);
        }
      }
      continue;
    }

    // system-message / user-message-metadata: skip, keep walking back.
  }

  if (openCallIds.size > 0) return true;
  if (sawTrailingAssistant && !trailingAssistantHasTerminalStop) return true;
  return false;
}

/**
 * How much of the tail of a transcript is read to decide liveness.
 *
 * The question this answers is "is the LAST record in the file still
 * open", which lives in the last handful of lines -- a few KB, ordinarily.
 * This is generous headroom for a large tool result sitting just before
 * the open call (a long bash capture, a big diff), while still being a
 * bounded read rather than the whole transcript. A transcript can be tens
 * of megabytes, and this runs on every session row of every list poll for
 * any session touched in the last `LIVE_TRANSCRIPT_WINDOW_MS`.
 *
 * Safe to keep fixed rather than growing on a miss: the transcript is
 * JSONL, one record per line, so a tail read that starts mid-file can only
 * ever corrupt the SINGLE leading fragment of its window -- every
 * complete line after that first newline is intact regardless of where
 * the read started. `tailIsUnfinishedTurn`'s own try/catch already skips
 * an unparseable line, so the worst case here is losing visibility into
 * one oversized record that straddles the window boundary, which is a
 * false "still live" for a little longer, not a false "finished".
 */
const LIVE_TAIL_BYTES = 256 * 1024;

/**
 * A turn is live when the transcript's tail is unfinished AND the file was
 * touched recently. Recency alone is not enough -- a finished turn's last
 * write is also "recent" for the first `LIVE_TRANSCRIPT_WINDOW_MS` after it
 * ends -- so both conditions have to hold.
 *
 * The recency check runs first and is a bare `statSync`: cheap, and it is
 * what keeps this affordable to call for every row in a session list --
 * ordinarily zero or one session is within the window at any moment, so
 * the tail read below almost never actually happens.
 */
interface TailCacheEntry {
  size: number;
  mtimeMs: number;
  unfinished: boolean;
}

/**
 * Bounded transcript-liveness reader.
 *
 * Session lists and sockets can ask about the same active file several
 * times per second. The file signature still gets checked on every call,
 * but an unchanged tail is parsed once. Recency is deliberately not cached:
 * a live-looking tail must still age out when no more bytes arrive.
 */
export class TranscriptLiveness {
  private readonly tails = new Map<string, TailCacheEntry>();

  constructor(private readonly maxEntries = 256) {}

  isLive(
    msgFile: string,
    opts: { now?: () => number; windowMs?: number } = {},
  ): boolean {
    const now = opts.now ?? Date.now;
    const windowMs = opts.windowMs ?? LIVE_TRANSCRIPT_WINDOW_MS;
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(msgFile, { throwIfNoEntry: false });
    } catch {
      return false;
    }
    if (!stat?.isFile()) return false;
    if (now() - stat.mtimeMs > windowMs) return false;

    const cached = this.tails.get(msgFile);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      // Refresh insertion order so frequently observed live sessions survive
      // eviction while old rows fall out naturally.
      this.tails.delete(msgFile);
      this.tails.set(msgFile, cached);
      return cached.unfinished;
    }

    const buffer = readTail(msgFile, stat.size, LIVE_TAIL_BYTES);
    if (buffer === null) return false;
    const unfinished = tailIsUnfinishedTurn(buffer);
    this.tails.set(msgFile, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      unfinished,
    });
    this.trim();
    return unfinished;
  }

  private trim(): void {
    while (this.tails.size > this.maxEntries) {
      const oldest = this.tails.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.tails.delete(oldest);
    }
  }
}

const sharedLiveness = new TranscriptLiveness();

export function transcriptIsLive(
  msgFile: string,
  opts: { now?: () => number; windowMs?: number } = {},
): boolean {
  return sharedLiveness.isLive(msgFile, opts);
}

/** Read up to the last `maxBytes` of a file, as text. */
function readTail(file: string, size: number, maxBytes: number): string | null {
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  if (length <= 0) return '';
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(length);
    const read = fs.readSync(fd, chunk, 0, length, start);
    return chunk.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
