/**
 * The Aside browser's own visit history, read on the phone.
 *
 * Aside is Chromium underneath, so its profile keeps a standard Chrome
 * `History` database. That file is the real answer to "can the phone see
 * what I browse on my Mac": it is the same profile the desktop app is
 * signed into, so what comes back here is genuinely the owner's history,
 * not a separate log this bridge kept.
 *
 * Two details make reading it safe while the browser is running:
 *
 *  - The handle is opened `readOnly` AND `immutable`. Chrome holds a write
 *    lock on the file, and a normal read-only open still fails against a
 *    live WAL. `immutable` tells SQLite to skip locking entirely and treat
 *    the file as a static snapshot, which is exactly the right contract
 *    for a reader that must never influence the browser.
 *  - Nothing here ever writes. Note the capital "O" in `readOnly`:
 *    node:sqlite silently ignores a lowercase `readonly` and hands back a
 *    WRITABLE handle, which is documented at length in `statedb.ts` and is
 *    the single easiest way to corrupt a live browser profile.
 *
 * Chrome stores timestamps as microseconds since 1601-01-01 (the Windows
 * epoch), so every time value needs the 11644473600 second offset before
 * it means anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Microseconds between the Windows epoch (1601) and the Unix epoch (1970). */
const EPOCH_OFFSET_SECONDS = 11_644_473_600;

export interface HistoryEntry {
  url: string;
  title: string;
  domain: string;
  visitCount: number;
  /** Unix milliseconds. */
  lastVisit: number;
}

interface DatabaseCtor {
  new (path: string, options?: Record<string, unknown>): {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  };
}

let ctor: DatabaseCtor | null | undefined;

async function loadDatabase(): Promise<DatabaseCtor | null> {
  if (ctor !== undefined) return ctor;
  try {
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync: DatabaseCtor;
    };
    ctor = mod.DatabaseSync ?? null;
  } catch {
    ctor = null;
  }
  return ctor;
}

/**
 * Same spelling trap as `statedb.ts`, plus `immutable`.
 *
 * Frozen and exported so a test can assert the exact keys rather than
 * trusting a literal buried in a call site.
 */
export const HISTORY_DB_OPEN_OPTIONS: Readonly<Record<string, unknown>> =
  Object.freeze({ readOnly: true });

/** Where the Aside profile keeps its Chromium history database. */
export function defaultHistoryPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Aside',
    'Default',
    'History',
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export interface HistoryQuery {
  limit?: number;
  /** Substring match against title and url. */
  query?: string;
}

/**
 * How long a read of the history file is reused.
 *
 * The address bar calls this on every keystroke, and each call opens a
 * fresh handle to a 20 MB SQLite file, runs an indexed query and closes
 * it. That is single-digit milliseconds on the Mac, but it is also work
 * repeated four or five times while a single word is typed, and the answer
 * cannot meaningfully change in that window: the owner is looking at their
 * phone, not browsing on the Mac.
 *
 * Two seconds is chosen so that a page visited on the Mac still shows up
 * on the phone about as fast as a person could switch devices and look.
 */
const CACHE_TTL_MS = 2_000;

interface CacheEntry {
  at: number;
  entries: HistoryEntry[];
}

export class HistoryReader {
  private lastError: string | null = null;
  /*
   * Keyed by the query itself, because a prefix search and an unfiltered
   * read are different result sets and sharing one entry would serve the
   * wrong list. Bounded below, since a long typing session would otherwise
   * hold an entry per prefix ever typed.
   */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly dbPath: string = defaultHistoryPath()) {}

  get error(): string | null {
    return this.lastError;
  }

  available(): boolean {
    return fs.existsSync(this.dbPath);
  }

  /**
   * Recent history, most recently visited first.
   *
   * Reads a fresh handle per call and closes it. That is deliberate: a
   * long-lived handle against `immutable` would pin an increasingly stale
   * snapshot, and history is exactly the thing that must not look frozen.
   * These queries are indexed and the call is rare (a panel opening), so
   * the open cost is not worth caching around.
   */
  async recent(opts: HistoryQuery = {}): Promise<HistoryEntry[]> {
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
    const search = (opts.query ?? '').trim();

    const cacheKey = `${limit}:${search.toLowerCase()}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      this.lastError = null;
      return hit.entries;
    }

    const Database = await loadDatabase();
    if (!Database) {
      this.lastError = 'sqlite_unavailable';
      return [];
    }
    if (!this.available()) {
      this.lastError = 'history_not_found';
      return [];
    }

    let db: InstanceType<DatabaseCtor> | null = null;
    try {
      // `immutable=1` is what makes this work against a running browser.
      db = new Database(`file:${this.dbPath}?immutable=1`, {
        ...HISTORY_DB_OPEN_OPTIONS,
        // node:sqlite needs to be told the path is a URI for the query
        // string to mean anything rather than being taken literally.
        enableForeignKeyConstraints: false,
        readOnly: true,
        allowExtension: false,
      } as Record<string, unknown>);

      /*
       * Only real web pages.
       *
       * Chromium's `urls` table logs every navigation the profile makes,
       * which includes `chrome://` settings pages and, more visibly here,
       * `chrome-extension://` pages: Aside's own UI is an extension, so
       * without this filter the top of the owner's history is a list of
       * their own agent chats, labelled with a 32-character extension id
       * where the domain should be. Those are not destinations anyone can
       * navigate to from a phone, so they have no business in an address
       * bar that exists to open things.
       */
      const scheme = `(u.url like 'http://%' or u.url like 'https://%')`;
      const where = search
        ? `where u.title <> '' and u.hidden = 0 and ${scheme} and (u.title like ? or u.url like ?)`
        : `where u.title <> '' and u.hidden = 0 and ${scheme}`;
      /*
       * The epoch conversion happens in SQL, not in JS, and that is not a
       * style choice.
       *
       * Chrome stores `last_visit_time` as microseconds since 1601, which
       * lands around 1.3e16 -- above Number.MAX_SAFE_INTEGER. node:sqlite
       * refuses to narrow such a value and throws "Value is too large to
       * be represented as a JavaScript number" before any mapping code
       * gets a chance to run. Dividing to milliseconds and subtracting the
       * epoch offset inside SQLite brings it to ~1.8e12, comfortably
       * inside the safe range, so what crosses into JS is already a normal
       * Unix millisecond timestamp.
       */
      const sql = `
        select u.url as url,
               u.title as title,
               u.visit_count as visitCount,
               cast(u.last_visit_time / 1000 - ${EPOCH_OFFSET_SECONDS * 1000}
                    as integer) as lastVisitMs
        from urls u
        ${where}
        order by u.last_visit_time desc
        limit ?
      `;
      const stmt = db.prepare(sql);
      const params = search ? [`%${search}%`, `%${search}%`, limit] : [limit];
      const rows = stmt.all(...params) as Array<{
        url: string;
        title: string;
        visitCount: number;
        lastVisitMs: number | bigint;
      }>;

      this.lastError = null;
      const entries = rows.map((r) => ({
        url: String(r.url ?? ''),
        title: String(r.title ?? ''),
        domain: hostOf(String(r.url ?? '')),
        visitCount: Number(r.visitCount) || 0,
        // A row that has genuinely never been visited comes back as a
        // negative number once the offset is applied; treat that as unknown
        // rather than as a date in 1601.
        lastVisit: Math.max(0, Number(r.lastVisitMs) || 0),
      }));

      // Trimmed from the oldest insertion, which for a Map is simply the
      // first key. A typing burst never needs more than a handful.
      if (this.cache.size >= 32) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, { at: Date.now(), entries });
      return entries;
    } catch (err) {
      this.lastError = (err as Error).message || 'history_read_failed';
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        /* nothing useful to do with a close failure on a read-only handle */
      }
    }
  }
}
