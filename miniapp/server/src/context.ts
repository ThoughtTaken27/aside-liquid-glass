/**
 * Opt-in, ephemeral context over Next's existing structured inputs.
 * No capture, page text, model call, network, persistent evidence cache or action.
 * Source observations are data, never instructions or permission to finish work.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RawItem } from './next.js';
import { trailKey, type TrailEntry } from './worktrail.js';

export type ContextSource = 'schoology' | 'work-trail';
export interface ContextPolicy {
  version: 1;
  enabled: true;
  sources: readonly ContextSource[];
}
export interface ContextRecord {
  taskId: string;
  source: ContextSource;
  sourceId: string;
  kind: 'source-status' | 'foreground-activity';
  observedAt: string | null;
  expiresAt: string | null;
  freshness: 'fresh' | 'stale' | 'unknown';
  confidence: 'structured-source' | 'exact-identity' | 'unknown';
  value?: 'reported-open' | 'reported-complete';
  minutes?: number;
}
export interface LocalContext {
  version: 1;
  /** Changes when source controls or forgetting invalidate older evidence. */
  revision?: number;
  sources: readonly ContextSource[];
  records: ContextRecord[];
  truncated: boolean;
}
const HOUR = 3_600_000;
const SOURCE_TTL = 24 * HOUR;
const ACTIVITY_TTL = 48 * HOUR;
const MAX_RECORDS = 200;

/** Missing, unreadable, over-sized, writable-by-others or invalid policy means off. */
export function readContextPolicy(asideRoot: string): ContextPolicy | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(asideRoot, 'next/context-policy.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) return null;
    const buffer = Buffer.alloc(4097);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 4096) return null;
    const c: unknown = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const p = c as Record<string, unknown>;
    if (Object.keys(p).some(k => !['version', 'enabled', 'sources'].includes(k))) return null;
    if (p.version !== 1 || p.enabled !== true || !Array.isArray(p.sources) || !p.sources.length || p.sources.length > 2) return null;
    if (p.sources.some(s => s !== 'schoology' && s !== 'work-trail') || new Set(p.sources).size !== p.sources.length) return null;
    return { version: 1, enabled: true, sources: p.sources as ContextSource[] };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validTime(value: unknown, now: number): number | null {
  const time = typeof value === 'number' ? value : typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && time <= now ? time : null;
}

/** Pure projection, using untransformed source records, never model completion hints. */
export function buildLocalContext(policy: ContextPolicy | null, raws: readonly RawItem[], trail: readonly TrailEntry[], date: Date): LocalContext | null {
  if (!policy || policy.version !== 1 || policy.enabled !== true) return null;
  const now = date.getTime();
  if (!Number.isFinite(now)) return null;
  const records: ContextRecord[] = [];
  let truncated = false;
  const push = (record: ContextRecord) => { if (records.length < MAX_RECORDS) records.push(record); else truncated = true; };
  const seen = new Set<string>();
  for (const raw of raws) {
    if (!raw || seen.has(raw.id) || raw.source === 'mail' || raw.source === 'school-mail' || raw.taint === 'email' || raw.flag) continue;
    if (typeof raw.id !== 'string' || !/^[\w:.-]{1,140}$/.test(raw.id)) continue;
    seen.add(raw.id);
    if (raw.source === 'schoology' && /^schoology:\d{6,25}$/.test(raw.id) && policy.sources.includes('schoology')) {
      const at = validTime(raw.checkedAt, now);
      push({ taskId: raw.id, source: 'schoology', sourceId: raw.id, kind: 'source-status',
        observedAt: at === null ? null : new Date(at).toISOString(),
        expiresAt: at === null ? null : new Date(at + SOURCE_TTL).toISOString(),
        freshness: at === null ? 'unknown' : now < at + SOURCE_TTL ? 'fresh' : 'stale',
        confidence: at === null ? 'unknown' : 'structured-source', value: raw.resolved ? 'reported-complete' : 'reported-open' });
    }
    if (!policy.sources.includes('work-trail') || !raw.url) continue;
    const key = trailKey(raw.url)?.key;
    // A site-wide Common App bucket is not an exact task/document identity.
    if (!key || key === 'commonapp' || key.length > 160) continue;
    const candidates = trail.filter(t => t.key === key && trailKey(t.url)?.key === key)
      .filter(t => { const at = validTime(t.lastAt, now); return at !== null && now < at + ACTIVITY_TTL && Number.isFinite(t.minutes) && t.minutes > 0 && t.minutes <= 1440; })
      .sort((a, b) => b.lastAt - a.lastAt);
    const hit = candidates[0];
    if (!hit) continue;
    push({ taskId: raw.id, source: 'work-trail', sourceId: key, kind: 'foreground-activity',
      observedAt: new Date(hit.lastAt).toISOString(), expiresAt: new Date(hit.lastAt + ACTIVITY_TTL).toISOString(),
      freshness: 'fresh', confidence: 'exact-identity', minutes: Math.round(hit.minutes) });
  }
  return { version: 1, sources: [...policy.sources], records, truncated };
}
