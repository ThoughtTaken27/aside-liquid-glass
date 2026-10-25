/**
 * Work trail: what the owner was actually working on, from the Aside
 * browser's own history, and nothing else.
 *
 * Privacy contract (tested):
 *  - The SQL itself only matches an allowlist of work hosts, so no other
 *    browsing ever leaves SQLite, let alone reaches the phone.
 *  - Read-only + immutable handle, same as history.ts.
 *  - Output is titles, links and minutes. No page content, ever.
 *
 * Time is Chromium's own foreground duration per visit (the tab was
 * actually in front), not how long a tab sat open in the background.
 */
import { defaultHistoryPath } from './history.js';

const EPOCH_OFFSET_SECONDS = 11_644_473_600;

export type TrailKind = 'Doc' | 'Slides' | 'Sheet' | 'Form' | 'Schoology' | 'Common App' | 'Classroom';

export interface TrailEntry {
  key: string;
  kind: TrailKind;
  title: string;
  url: string;
  /** Unix ms of the last visit. */
  lastAt: number;
  /** Foreground minutes inside the window. */
  minutes: number;
}

/** Hosts the reader may look at. Everything else is excluded in SQL. */
export const WORK_URL_PATTERNS: readonly string[] = Object.freeze([
  'https://docs.google.com/%',
  'https://%.schoology.com/%',
  'https://apply.commonapp.org/%',
  'https://classroom.google.com/%',
]);

export interface TrailRow {
  url: string;
  title: string;
  visitMs: number;
  foregroundUs: number;
}

const GENERIC = /^(|google (docs|slides|sheets|forms)|schoology|home|untitled (document|presentation|spreadsheet)|my common application)$/i;

function cleanTitle(title: string): string {
  return title
    .replace(/\s+-\s+Google (Docs|Slides|Sheets|Forms)$/i, '')
    .replace(/\s+\|\s+(Schoology|Common App)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Stable identity for a URL, or null when it is not a unit of work. */
export function trailKey(raw: string): { key: string; kind: TrailKind; url: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname;
  const p = u.pathname;
  if (host === 'docs.google.com') {
    const m = p.match(/\/(document|presentation|spreadsheets|forms)(?:\/u\/\d+)?\/d\/(?:e\/)?([\w-]{20,})/);
    if (!m) return null;
    const kind: TrailKind =
      m[1] === 'document' ? 'Doc' : m[1] === 'presentation' ? 'Slides' : m[1] === 'spreadsheets' ? 'Sheet' : 'Form';
    const base = m[1] === 'forms' ? `https://docs.google.com/forms/d/e/${m[2]}/viewform` : `https://docs.google.com/${m[1]}/d/${m[2]}/edit`;
    return { key: `gdoc:${m[2]}`, kind, url: base };
  }
  if (host.endsWith('.schoology.com')) {
    const m =
      p.match(/\/assignment\/(\d{6,})/) ||
      p.match(/\/(?:assessments|common-assessment|common-assessment-delivery\/start)\/(\d{6,})/) ||
      p.match(/\/materials\/gp\/(\d{6,})/);
    if (!m) return null;
    return { key: `schoology:${m[1]}`, kind: 'Schoology', url: `https://${host}${p}` };
  }
  if (host === 'apply.commonapp.org') {
    if (!/^\/common\//.test(p)) return null;
    return { key: 'commonapp', kind: 'Common App', url: 'https://apply.commonapp.org/dashboard' };
  }
  if (host === 'classroom.google.com') {
    const m = p.match(/\/a\/([\w-]{6,})/);
    if (!m) return null;
    return { key: `classroom:${m[1]}`, kind: 'Classroom', url: `https://classroom.google.com${p}` };
  }
  return null;
}

/** Pure aggregation, so it is testable without a database. */
export function aggregateTrail(rows: TrailRow[], now: number, minMinutes = 2): TrailEntry[] {
  const by = new Map<string, TrailEntry & { titles: Map<string, number> }>();
  for (const row of rows) {
    const id = trailKey(row.url);
    if (!id) continue;
    const cur =
      by.get(id.key) ??
      { key: id.key, kind: id.kind, title: '', url: id.url, lastAt: 0, minutes: 0, titles: new Map() };
    cur.lastAt = Math.max(cur.lastAt, row.visitMs);
    cur.minutes += Math.max(0, row.foregroundUs) / 60_000_000;
    const t = cleanTitle(row.title);
    if (!GENERIC.test(t)) cur.titles.set(t, (cur.titles.get(t) ?? 0) + 1);
    by.set(id.key, cur);
  }
  const out: TrailEntry[] = [];
  for (const e of by.values()) {
    if (e.minutes < minMinutes || e.lastAt > now + 60_000) continue;
    const best = [...e.titles.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
    const title = best?.[0] ?? (e.kind === 'Common App' ? 'Common App' : `Untitled ${e.kind === 'Doc' ? 'doc' : e.kind}`);
    out.push({ key: e.key, kind: e.kind, title, url: e.url, lastAt: e.lastAt, minutes: Math.round(e.minutes) });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

// --------------------------------------------------------------------------
// Matching trail entries to tasks.

const STOP = new Set(
  'the a an and or of to for in on at by with from your my is are be this that assignment worksheet hw homework day part unit due draft final'.split(' '),
);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/**
 * The trail entry a task is being worked in, if any. A Schoology id in the
 * task URL is an exact match; otherwise titles must share at least two
 * meaningful words and half of the shorter title.
 */
export function matchTrail(
  task: { title: string; url: string | null },
  trail: TrailEntry[],
): TrailEntry | null {
  const idMatch = task.url?.match(/\/(?:assignment|assessments?|common-assessment)\/(\d{6,})/);
  if (idMatch) {
    const hit = trail.find((t) => t.key === `schoology:${idMatch[1]}`);
    // The assignment page itself is not "working on it"; a doc with the
    // same name is. Prefer the doc when both exist.
    const doc = bestTitleMatch(task.title, trail.filter((t) => t.kind !== 'Schoology'));
    return doc ?? hit ?? null;
  }
  return bestTitleMatch(task.title, trail);
}

function bestTitleMatch(title: string, trail: TrailEntry[]): TrailEntry | null {
  const a = tokens(title);
  if (a.size === 0) return null;
  let best: TrailEntry | null = null;
  let bestScore = 0;
  for (const t of trail) {
    const b = tokens(t.title);
    if (b.size === 0) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    const ratio = shared / Math.min(a.size, b.size);
    const ok = (shared >= 2 && ratio >= 0.5) || (shared >= 1 && ratio === 1 && Math.min(a.size, b.size) === 1 && a.size <= 2);
    const score = shared + ratio + t.minutes / 1000;
    if (ok && score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

// --------------------------------------------------------------------------
// Reading.

interface Db {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

export class WorkTrailReader {
  private cache: { at: number; entries: TrailEntry[] } | null = null;

  constructor(
    private readonly dbPath: string = defaultHistoryPath(),
    private readonly windowHours = 48,
  ) {}

  async read(now = Date.now()): Promise<TrailEntry[]> {
    if (this.cache && now - this.cache.at < 30_000) return this.cache.entries;
    let db: Db | null = null;
    try {
      const mod = (await import('node:sqlite')) as unknown as {
        DatabaseSync: new (p: string, o: Record<string, unknown>) => Db;
      };
      db = new mod.DatabaseSync(`file:${this.dbPath}?immutable=1`, { readOnly: true, allowExtension: false });
      const cutoffUs = (Math.floor(now / 1000) - this.windowHours * 3600 + EPOCH_OFFSET_SECONDS) * 1_000_000;
      const likes = WORK_URL_PATTERNS.map(() => 'u.url like ?').join(' or ');
      const rows = db
        .prepare(
          `select u.url as url, u.title as title,
                  cast(v.visit_time / 1000 - ${EPOCH_OFFSET_SECONDS * 1000} as integer) as visitMs,
                  coalesce(ca.total_foreground_duration, 0) as foregroundUs
           from visits v
           join urls u on u.id = v.url
           left join context_annotations ca on ca.visit_id = v.id
           where v.visit_time > ? and (${likes})
           order by v.visit_time desc
           limit 2000`,
        )
        .all(cutoffUs, ...WORK_URL_PATTERNS) as Array<Record<string, unknown>>;
      const entries = aggregateTrail(
        rows.map((r) => ({
          url: String(r.url ?? ''),
          title: String(r.title ?? ''),
          visitMs: Number(r.visitMs) || 0,
          foregroundUs: Number(r.foregroundUs) || 0,
        })),
        now,
      );
      this.cache = { at: now, entries };
      return entries;
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        /* read-only handle */
      }
    }
  }
}
