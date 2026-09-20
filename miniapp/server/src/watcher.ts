/**
 * Live tail of a session's messages.jsonl.
 *
 * fs.watch is the fast path and a 1.5s poll is the fallback (fs.watch is
 * unreliable across editors/atomic renames, and the file may not exist yet
 * for a session the CLI is still creating). Reads are byte-offset based and
 * stop at the last newline, so a half-written final line is simply picked up
 * on the next pass -- the same guarantee bridge.py's `stream_new` relies on.
 */
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { TranscriptParser, type TranscriptEntry } from './transcript.js';

/**
 * Poll floor. fs.watch is the fast path and normally fires first; this is
 * the backstop for the cases where it does not (atomic renames, network
 * volumes). Round 3 tightened it from 1.5s to 800ms so the worst-case
 * latency from a transcript write to a client update stays under a second
 * even when fs.watch is asleep.
 */
const POLL_MS = 800;

/**
 * Incremental newline framing for append-only JSONL.
 *
 * Partial records stay in memory until their newline arrives. The watcher
 * can therefore advance its file cursor after every read instead of reading
 * the same growing partial record again on every fs event.
 */
export class JsonlFramer {
  private partial: Buffer[] = [];

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] !== 0x0a) continue;
      const segment = chunk.subarray(start, i);
      let line: Buffer;
      if (this.partial.length) {
        this.partial.push(segment);
        line = Buffer.concat(this.partial);
        this.partial = [];
      } else {
        line = segment;
      }
      lines.push(line.toString('utf8'));
      start = i + 1;
    }
    if (start < chunk.length) {
      // Copy the tail so a tiny partial line does not retain a much larger
      // read buffer that also contained many complete records.
      this.partial.push(Buffer.from(chunk.subarray(start)));
    }
    return lines;
  }

  reset(): void {
    this.partial = [];
  }
}

export class SessionWatcher extends EventEmitter {
  private bytePos = 0;
  private lineNo = 0;
  private parser = new TranscriptParser();
  private timer: NodeJS.Timeout | null = null;
  private fsWatcher: fs.FSWatcher | null = null;
  private started = false;
  private framer = new JsonlFramer();
  private fileIdentity = '';
  /** Last mtime seen, so a partial-line write can still be reported as activity. */
  private lastMtimeMs = 0;
  refs = 0;

  constructor(
    readonly sessionId: string,
    readonly msgFile: string,
  ) {
    super();
  }

  /** Highest line index consumed so far (-1 when nothing has been read). */
  get lastLine(): number {
    return this.lineNo - 1;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Prime silently: everything already on disk is backlog the client
    // fetches over REST, but the parser still needs it for subagent state.
    this.consume(false);
    this.timer = setInterval(() => this.consume(true), POLL_MS);
    this.timer.unref?.();
    this.attachFsWatch();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.fsWatcher?.close();
    this.fsWatcher = null;
    this.removeAllListeners();
  }

  private attachFsWatch(): void {
    try {
      this.fsWatcher = fs.watch(this.msgFile, () => this.consume(true));
      this.fsWatcher.on('error', () => {
        this.fsWatcher?.close();
        this.fsWatcher = null; // the interval keeps us honest
      });
    } catch {
      // file not created yet -- polling covers it, and we retry on each pass
    }
  }

  private consume(emit: boolean): void {
    const stat = fs.statSync(this.msgFile, { throwIfNoEntry: false });
    if (!stat?.isFile()) return;
    if (!this.fsWatcher) this.attachFsWatch();

    /**
     * The file moved even if nothing below finds a complete line to
     * parse. A single long-running tool call -- a slow bash command
     * streaming output that has not hit its closing brace yet -- writes
     * bytes without ever completing the JSONL line those bytes belong
     * to, so the early return at "only a partial line so far" used to
     * mean total silence on this watcher for the whole duration of that
     * call. `transcriptIsLive` reads the file's mtime to decide
     * liveness, so an 'activity' event with no entries is enough to
     * make the socket re-push and pick that mtime up -- it does not need
     * a parsed entry to know the turn is still going.
     */
    if (stat.mtimeMs !== this.lastMtimeMs) {
      this.lastMtimeMs = stat.mtimeMs;
      if (emit) this.emit('activity');
    }

    const identity = `${stat.dev}:${stat.ino}`;
    if (
      (this.fileIdentity && identity !== this.fileIdentity) ||
      stat.size < this.bytePos
    ) {
      // Truncated or atomically replaced: start over rather than joining a
      // partial record from the old file to bytes from the new one.
      this.bytePos = 0;
      this.lineNo = 0;
      this.parser = new TranscriptParser();
      this.framer.reset();
    }
    this.fileIdentity = identity;
    if (stat.size <= this.bytePos) return;

    let chunk: Buffer;
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.msgFile, 'r');
      const length = stat.size - this.bytePos;
      chunk = Buffer.alloc(length);
      const read = fs.readSync(fd, chunk, 0, length, this.bytePos);
      chunk = chunk.subarray(0, read);
      this.bytePos += read;
    } catch {
      return;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }

    const lines = this.framer.push(chunk);
    if (!lines.length) return;

    const entries: TranscriptEntry[] = [];
    for (const line of lines) {
      entries.push(...this.parser.feedLine(line, this.lineNo));
      this.lineNo += 1;
    }
    if (emit && entries.length) this.emit('entries', entries);
  }
}

/** One watcher per session, shared by every subscriber, refcounted. */
export class WatcherRegistry {
  private watchers = new Map<string, SessionWatcher>();

  acquire(sessionId: string, msgFile: string): SessionWatcher {
    let watcher = this.watchers.get(sessionId);
    if (!watcher) {
      watcher = new SessionWatcher(sessionId, msgFile);
      this.watchers.set(sessionId, watcher);
      watcher.start();
    }
    watcher.refs += 1;
    return watcher;
  }

  release(sessionId: string): void {
    const watcher = this.watchers.get(sessionId);
    if (!watcher) return;
    watcher.refs -= 1;
    if (watcher.refs <= 0) {
      watcher.stop();
      this.watchers.delete(sessionId);
    }
  }

  closeAll(): void {
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
  }
}
