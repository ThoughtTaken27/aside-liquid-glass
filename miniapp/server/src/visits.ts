/**
 * What the phone did, kept next to what the Mac did.
 *
 * The Mac's history lives in Chromium's own SQLite database (see
 * `history.ts`), and this file deliberately does not write to it. That is
 * not caution for its own sake: Chrome holds a write lock on that file
 * while it runs, the schema carries invariants across five tables that a
 * naive insert would violate, and a corrupt profile costs the owner every
 * tab, cookie and saved password they have. A separate log that is merged
 * at read time gets the same unified history with none of that risk.
 *
 * So "phone searches land in my Mac history" is satisfied by making both
 * sources answer the same query, rather than by making one write into the
 * other. From the address bar they are one list.
 *
 * The store is a small append-only JSON file, rewritten atomically. It is
 * capped, because an address bar only ever reads the recent end of it and
 * an unbounded file on a laptop is a slow leak.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Beyond this the oldest entries are dropped on the next write. */
const MAX_ENTRIES = 2_000;

/** Debounce for disk writes: a burst of taps should cost one write. */
const FLUSH_DELAY_MS = 1_500;

export type VisitKind = 'search' | 'page';

export interface Visit {
  kind: VisitKind;
  /** The query for a search, the page title for a page. */
  title: string;
  /** The SERP url for a search, the page url for a page. */
  url: string;
  domain: string;
  /** Unix milliseconds. */
  at: number;
  /** Times this exact url has been recorded. */
  count: number;
}

export function defaultVisitsPath(): string {
  return path.join(os.homedir(), '.aside-mobile', 'phone-history.json');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export class VisitStore {
  private entries: Visit[] = [];
  private loaded = false;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string = defaultVisitsPath()) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter(isVisit);
      }
    } catch {
      // A missing or unreadable log is an empty log. There is nothing here
      // worth failing a request over: it is a convenience index, and it
      // rebuilds itself from the next tap.
      this.entries = [];
    }
  }

  /**
   * Record a search or a page open.
   *
   * Repeating a url updates the existing entry rather than appending, so
   * the ranking sees a visit count instead of a wall of duplicates, which
   * is the same thing Chrome's `urls` table does.
   */
  async record(input: {
    kind: VisitKind;
    title: string;
    url: string;
    at?: number;
  }): Promise<Visit> {
    await this.load();
    const at = input.at ?? Date.now();
    const url = input.url.slice(0, 2_000);
    const key = url.toLowerCase();

    const idx = this.entries.findIndex((e) => e.url.toLowerCase() === key);
    let entry: Visit;
    if (idx >= 0) {
      entry = { ...this.entries[idx], at, count: this.entries[idx].count + 1 };
      if (input.title) entry.title = input.title.slice(0, 300);
      this.entries.splice(idx, 1);
    } else {
      entry = {
        kind: input.kind,
        title: (input.title || url).slice(0, 300),
        url,
        domain: hostOf(url),
        at,
        count: 1,
      };
    }
    // Newest first, so trimming the tail drops the oldest.
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
    this.scheduleFlush();
    return entry;
  }

  /** Recent entries, newest first, optionally filtered by substring. */
  async recent(opts: { limit?: number; query?: string } = {}): Promise<Visit[]> {
    await this.load();
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
    const q = (opts.query ?? '').trim().toLowerCase();
    const source = q
      ? this.entries.filter(
          (e) =>
            e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q),
        )
      : this.entries;
    return source.slice(0, limit);
  }

  /** Distinct past queries, newest first. Used for search typeahead. */
  async queries(prefix = '', limit = 8): Promise<string[]> {
    await this.load();
    const p = prefix.trim().toLowerCase();
    const out: string[] = [];
    for (const e of this.entries) {
      if (e.kind !== 'search') continue;
      const text = e.title.trim();
      if (!text) continue;
      if (p && !text.toLowerCase().startsWith(p)) continue;
      if (out.some((o) => o.toLowerCase() === text.toLowerCase())) continue;
      out.push(text);
      if (out.length >= limit) break;
    }
    return out;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
    // A pending write must not hold the process open at shutdown.
    this.flushTimer.unref?.();
  }

  /** Write now. Serialised so two flushes cannot interleave. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot = JSON.stringify(this.entries);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        // Write-then-rename: a crash mid-write leaves the previous good
        // file in place rather than a truncated one.
        await fs.writeFile(tmp, snapshot, 'utf8');
        await fs.rename(tmp, this.file);
      } catch {
        // Losing the convenience index is survivable; failing the request
        // that triggered the write is not.
      }
    });
    return this.writing;
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

function isVisit(v: unknown): v is Visit {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    (o.kind === 'search' || o.kind === 'page') &&
    typeof o.title === 'string' &&
    typeof o.url === 'string' &&
    typeof o.at === 'number'
  );
}
