/**
 * Next: one thing to do now, a short queue behind it, everything else out
 * of sight.
 *
 * The split of labour is the whole design, so it is stated up front:
 *
 *  - Judgment runs elsewhere, occasionally. Aside routines (the school
 *    planner, the inbox sweep) read messy sources with a model and write
 *    structured items to disk: what, why, how long, how much it matters.
 *  - Everything here is plain arithmetic, run on every request. Urgency
 *    changes by the minute and a model is not needed to subtract two
 *    dates, so ranking is recomputed live from the stored components and
 *    the clock. No model call, no network, no tokens.
 *
 * Inputs are files the owner's own routines wrote, but their text came
 * from email and school pages, which anyone can author. So every field is
 * shape-checked and length-capped, URLs must be https, and nothing here
 * ever executes or follows an instruction found in an item.
 */
import fs from 'node:fs';
import path from 'node:path';
import { briefFor, type TaskBrief, type TaskKind } from './brief.js';
import { matchTrail, type TrailEntry } from './worktrail.js';
import { buildLocalContext, readContextPolicy, type LocalContext, type ContextRecord } from './context.js';
import { ContextMemory } from './context-memory.js';
import { trailKey } from './worktrail.js';
import { readPersonalMailConfig } from './inbox.js';

export type NextLane = 'you' | 'prep' | 'aside';
export type NextSource = 'schoology' | 'school-mail' | 'mail' | 'calendar' | 'manual' | 'project';
/** School and personal never mix: every item, notice, and source lives in exactly one. */
export type NextSpace = 'school' | 'personal';

/** Where something lives. Source decides for school feeds; tasks and projects carry their own. */
export function spaceOf(r: { source: NextSource; space?: NextSpace | null }): NextSpace {
  if (r.source === 'schoology' || r.source === 'school-mail') return 'school';
  if (r.source === 'mail' || r.source === 'calendar') return 'personal';
  return r.space === 'school' ? 'school' : 'personal';
}

export function sourceSpace(id: string): NextSpace {
  return id === 'schoology' || id === 'school-mail' ? 'school' : 'personal';
}
export type NextStatus = 'open' | 'done' | 'snoozed' | 'dismissed' | 'handed-off';

export interface NextItem {
  /** Source evidence is data, not a completion signal or an action permission. */
  evidence?: { revision: number; records: ContextRecord[]; influence: 'equal-priority-resume' | null };
  id: string;
  source: NextSource;
  space: NextSpace;
  title: string;
  /** Short context line: the course, or who asked. */
  context: string;
  dueISO: string | null;
  estMinutes: number | null;
  lane: NextLane;
  /** One sentence: why this matters now. */
  why: string;
  url: string | null;
  steps: string[];
  /** 0..1. Below UNSURE_BELOW the item waits for a yes/no instead of ranking. */
  confidence: number;
  /** Live score, 0..100. */
  score: number;
  overdue: boolean;
  /**
   * Past due AND the source was checked after the due time and still did
   * not show it turned in. Without that check, "late" would be a guess.
   */
  lateConfirmed: boolean;
  status: NextStatus;
  closedBy: 'you' | 'source' | null;
  closedAt: string | null;
  snoozedUntil: string | null;
  sessionId: string | null;
  kind: TaskKind;
  /** What Aside will and will not do; decided by code (brief.ts). */
  brief: TaskBrief;
  /** Where this is already being worked on, from the work trail. */
  trail: TrailRef | null;
  /** Any text here came from email: no tool-using agent may see it. */
  taint: 'email' | null;
  /** Looks like an injection or phishing attempt. */
  flag: 'suspicious' | null;
  /** Why it was flagged, in plain words. */
  flagReason: string | null;
  /** The email's main link, checked against who sent it (inbox.ts). */
  link: ItemLink | null;
  /** Who an email came from: display name and domain only. */
  sender: ItemSender | null;
  /** What an email asks him to do, one sentence. */
  ask: string | null;
  /** When a reply draft for this was saved to Gmail. */
  draftedAt: string | null;
  /** Personal Gmail still on trial. */
  trial?: boolean;
  /** Jev hints (nextjev.ts). Hints only: nothing here closes or hides work without a tap, except a duplicate folded into its twin. */
  doneHint?: DoneHint | null;
  alsoFrom?: AlsoFrom[];
  estBy?: 'source' | 'jev';

  /** For items with Aside: what the agent is doing right now. */
  live?: NextLive | null;
  /** The latest brief Next wrote about this item, if he asked it to look. */
  /** He tapped "Let Next help" and it is waiting for a locked browser. */
  handoff?: { state: 'waiting'; readyInMin: number | null } | null;
  research?: { id: string; state: 'preparing' | 'running' | 'ready' | 'failed' | 'dismissed'; verdictLabel: string | null } | null;
}

export interface ItemLink {
  url: string;
  host: string;
  verified: boolean;
  reason: string;
}

export interface ItemSender {
  name: string;
  host: string;
  school: boolean;
  /** district = staff domain and Gmail's DMARC check passed. */
  tier: 'district' | 'student' | 'outside';
}

export interface NextLive {
  busy: boolean;
  /** The agent's own purpose line for its current step, never tool args. */
  step: string | null;
  startedAt: string | null;
  /** The agent's browser tab, when it has one. */
  tab: { targetId: string; url: string } | null;
  /** The helper's last reply once it stops (Sep 27), shown on the task. */
  result?: string | null;
}

export interface TrailRef {
  title: string;
  kind: string;
  url: string;
  lastAt: string;
  minutes: number;
}

/** Something worth a look that is not a task (a grade posted, an FYI). */
export interface NextNotice {
  id: string;
  source: NextSource;
  space: NextSpace;
  title: string;
  context: string;
  why: string;
  url: string | null;
  at: string | null;
  flag: 'suspicious' | null;
  flagReason: string | null;
  sender: ItemSender | null;
}

export interface NextSourceStatus {
  id: string;
  space?: NextSpace;
  label: string;
  updatedAt: string | null;
  count: number;
  ok: boolean;
}

export interface NextPlan {
  /** Opt-in, local, ephemeral provenance; never an action or completion authority. */
  context?: LocalContext;
  generatedAt: string;
  now: NextItem | null;
  next: NextItem[];
  withAside: NextItem[];
  unsure: NextItem[];
  later: NextItem[];
  doneToday: NextItem[];
  /** Up to three things worth a look that are not tasks. */
  notices: NextNotice[];
  /** The most recent real work session that is not already the hero. */
  pickUp: TrailRef | null;
  /** One plain sentence on the day, from the data (no model). */
  dayLine: string;
  /** Estimated minutes for now + next. */
  queuedMinutes: number;
  sources: NextSourceStatus[];
  /**
   * A prompt that refreshes the feeds on demand (e.g. an inbox sweep),
   * read from `<aside root>/next/inbox-sweep.md`. Null when absent.
   */
  /** Personal Gmail on trial, apart from Today. */
  review: NextItem[];
  /** Counts of private and flagged personal mail, in plain words. No content. */
  personalNote: string | null;
  refreshPrompt: string | null;
  /** The pause switch (control.ts). Set by the server route. */
  control?: { paused: boolean; pausedAt: string | null; reason: string | null };
  /** Active projects, one line each (projects.ts). Set by the server route. */
  projects?: Array<{ id: string; space: NextSpace; title: string; health: string; line: string; deadlineISO: string; done: number; total: number; todayMin: number }>;
}

/** Raw, pre-score item as the adapters produce it. */
export interface RawItem {
  id: string;
  source: NextSource;
  /** Only tasks and projects set this; feeds get theirs from the source. */
  space?: NextSpace;
  title: string;
  context: string;
  dueISO: string | null;
  estMinutes: number | null;
  lane: NextLane;
  why: string;
  url: string | null;
  steps: string[];
  confidence: number;
  impact: number;
  lateRisk: number;
  dependency: number;
  /** The source itself says this is finished (submitted, graded, replied). */
  resolved: boolean;
  /** Still accepted after the due date. */
  acceptsLate: boolean;
  kind?: TaskKind;
  taint?: 'email' | null;
  flag?: 'suspicious' | null;
  /** When the source item was sent or posted (notices sort by it). */
  atISO?: string | null;
  flagReason?: string | null;
  link?: ItemLink | null;
  sender?: ItemSender | null;
  ask?: string | null;
  /** When the source last looked at this item's submission state. */
  checkedAt?: string | null;
  /** Personal Gmail on trial: shown only in its own list until he taps Keep. */
  trial?: boolean;
  /** Jev hints (nextjev.ts). Hints only: nothing here closes or hides work without a tap, except a duplicate folded into its twin. */
  doneHint?: DoneHint | null;
  alsoFrom?: AlsoFrom[];
  estBy?: 'source' | 'jev';
}

export interface DoneHint {
  /** The email that reads like proof it's finished (subject only), or the sentence Aside's screen summary used. */
  subject: string;
  at: string;
  p: number;
  /** Oct 21: 'screen' when it came from Aside's Context Awareness rather than a receipt email. */
  via?: 'email' | 'screen';
}

export interface AlsoFrom {
  id: string;
  source: NextSource;
  title: string;
}

/** Personal Gmail ids. No helper, research, or reply writer ever runs on them. */
export function isPersonalMailId(id: string): boolean {
  return /^personal-mail:/.test(id);
}

export interface NextUserState {
  items: Record<
    string,
    {
      status?: 'done' | 'snoozed' | 'dismissed' | 'handed-off' | 'kept';
      at?: string;
      until?: string;
      sessionId?: string;
      /** A reply draft was saved to Gmail for this item. */
      draftedAt?: string;
    }
  >;
}

export const UNSURE_BELOW = 0.7;
const NEXT_COUNT = 3;
const MAX_TITLE = 140;
const MAX_TEXT = 280;
const MAX_STEPS = 5;
/** Past-due items stop surfacing after this, even if still technically open. */
const STALE_OVERDUE_MS = 7 * 24 * 60 * 60 * 1000;

// --------------------------------------------------------------------------
// Scoring. Mirrors the school planner's URGENCY table so the phone and the
// written plan never disagree about what is urgent.

export function urgencyFor(dueISO: string | null, estMinutes: number | null, now: Date): number {
  if (!dueISO) return 1;
  const due = Date.parse(dueISO);
  if (!Number.isFinite(due)) return 1;
  const hours = (due - now.getTime()) / 3_600_000;
  let u: number;
  if (hours < 0) u = 30;
  else if (hours <= 12) u = 28;
  else if (hours <= 24) u = 24;
  else if (hours <= 48) u = 18;
  else if (hours <= 72) u = 13;
  else if (hours <= 120) u = 9;
  else if (hours <= 168) u = 6;
  else if (hours <= 336) u = 3;
  else u = 1;
  // Start-by pressure: a long task due in a few days is urgent today.
  if (estMinutes && hours > 0) {
    const startBy = due - 2.5 * estMinutes * 60_000;
    if (now.getTime() >= startBy) u = Math.max(u, 22);
  }
  return u;
}

export function scoreItem(raw: RawItem, now: Date, trail: TrailRef | null = null): number {
  const base = clamp(raw.impact, 0, 50) + clamp(raw.lateRisk, 0, 12) + clamp(raw.dependency, 0, 8);
  // Momentum: work already started in the last day is cheaper to finish.
  const started =
    trail && trail.minutes >= 5 && now.getTime() - Date.parse(trail.lastAt) < 24 * 3_600_000 ? 4 : 0;
  return Math.round(Math.min(100, base + started + urgencyFor(raw.dueISO, raw.estMinutes, now)));
}

// --------------------------------------------------------------------------
// Adapter: the school planner's cache.

/** "2026-09-21" means checked sometime that day: count it as the start. */
function dayEndISO(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0).toISOString();
}

interface SchoologyNote {
  lastEnriched?: unknown;
  title?: unknown;
  course?: unknown;
  courseId?: unknown;
  dueISO?: unknown;
  category?: unknown;
  categoryWeight?: unknown;
  maxPoints?: unknown;
  type?: unknown;
  attemptState?: unknown;
  estMinutes?: unknown;
  url?: unknown;
  /** Optional, written by the planner routine when it scores the item. */
  components?: { impact?: unknown; lateRisk?: unknown; dependency?: unknown };
  why?: unknown;
  steps?: unknown;
  lane?: unknown;
}

const TYPE_SIZE: Record<string, number> = {
  'test-quiz': 0.7,
  assessment: 0.5,
  assignment: 0.35,
  event: 0.05,
  scorm: 0.2,
};

/** "AP Physics I F 309975" -> "AP Physics I". Section codes are noise on a phone. */
export function tidyCourse(course: string): string {
  return course
    .replace(/\s+F\s+\d+.*$/, '')
    .replace(/\s+\d{5,}.*$/, '')
    .replace(/\bHnrs\b/, 'Honors')
    .trim();
}

function schoologyResolved(state: string): boolean {
  return /\b(graded|submitted)\b/i.test(state) && !/not submitted/i.test(state);
}

export function adaptSchoology(
  notes: Record<string, SchoologyNote>,
  excluded: Set<string>,
  now: Date,
  base: string | null = null,
): RawItem[] {
  const out: RawItem[] = [];
  for (const [contentId, note] of Object.entries(notes)) {
    if (!/^\d+$/.test(contentId)) continue;
    if (excluded.has(String(note.courseId ?? ''))) continue;
    const dueISO = isoOrNull(note.dueISO);
    if (!dueISO) continue; // Undated items are reference material, not tasks.
    const due = Date.parse(dueISO);
    if (now.getTime() - due > STALE_OVERDUE_MS) continue;
    const state = str(note.attemptState, 200);
    const resolved = schoologyResolved(state);
    const type = str(note.type, 30);
    if (type === 'event') continue;
    const weight = num(note.categoryWeight) ?? 20;
    const points = num(note.maxPoints);
    const size = points ? clamp(points / 50, 0.15, 1) : (TYPE_SIZE[type] ?? 0.35);
    const oneShot = /one attempt|no attempts left|locked/i.test(state);
    const c = note.components ?? {};
    const est = num(note.estMinutes);
    const course = tidyCourse(str(note.course, 80));
    out.push({
      id: `schoology:${contentId}`,
      source: 'schoology',
      title: str(note.title, MAX_TITLE) || 'Untitled assignment',
      context: course,
      dueISO,
      estMinutes: est,
      lane: asLane(note.lane) ?? 'you',
      why: str(note.why, MAX_TEXT) || fallbackWhy(weight, str(note.category, 40), oneShot),
      url:
        httpsOrNull(note.url) ??
        (base ? httpsOrNull(`${base.replace(/\/$/, '')}/assignment/${contentId}`) : null),
      steps: strList(note.steps),
      checkedAt: isoOrNull(note.lastEnriched) ?? dayEndISO(note.lastEnriched),
      confidence: 1,
      impact: num(c.impact) ?? Math.min(50, weight * 0.5 * size * 1.5 * 1.6),
      lateRisk: num(c.lateRisk) ?? (oneShot ? 7 : 3),
      dependency: num(c.dependency) ?? 0,
      resolved,
      acceptsLate: !/locked|not accepting/i.test(state),
    });
  }
  return out;
}

function fallbackWhy(weight: number, category: string, oneShot: boolean): string {
  const parts: string[] = [];
  if (category) parts.push(`${category}: ${Math.round(weight)}% of the grade`);
  if (oneShot) parts.push('one attempt only');
  return parts.length ? `${capitalise(parts.join(', '))}.` : '';
}

// --------------------------------------------------------------------------
// Adapter: generic feed files, one per producer routine.
//
// <aside root>/next/feeds/<producer>.json
// { "updatedAt": ISO, "label": "Inbox", "items": [ { id, source, title, ... } ] }

export function adaptFeed(raw: unknown): {
  label: string;
  updatedAt: string | null;
  items: RawItem[];
} {
  const feed = (raw ?? {}) as {
    label?: unknown;
    updatedAt?: unknown;
    items?: unknown;
  };
  const items: RawItem[] = [];
  const list = Array.isArray(feed.items) ? feed.items.slice(0, 200) : [];
  for (const entry of list) {
    const it = (entry ?? {}) as Record<string, unknown>;
    const id = str(it.id, 120);
    const title = str(it.title, MAX_TITLE);
    if (!id || !title || !/^[\w:.@<>+\-/=]+$/.test(id)) continue;
    items.push({
      id: id.includes(':') ? id : `feed:${id}`,
      source: asSource(it.source) ?? 'mail',
      title,
      context: str(it.context, 80),
      dueISO: isoOrNull(it.dueISO),
      estMinutes: num(it.estMinutes),
      lane: asLane(it.lane) ?? 'you',
      why: str(it.why, MAX_TEXT),
      url: httpsOrNull(it.url),
      steps: strList(it.steps),
      confidence: clamp(num(it.confidence) ?? 0.5, 0, 1),
      impact: clamp(num(it.impact) ?? 10, 0, 50),
      lateRisk: clamp(num(it.lateRisk) ?? 0, 0, 12),
      dependency: clamp(num(it.dependency) ?? 0, 0, 8),
      resolved: it.resolved === true,
      acceptsLate: it.acceptsLate !== false,
      kind: asKind(it.kind) ?? undefined,
      // Mail sources are always tainted, whatever the file claims.
      taint:
        it.taint === 'email' || asSource(it.source) === 'mail' || asSource(it.source) === 'school-mail' || !asSource(it.source)
          ? 'email'
          : null,
      flag: it.flag === 'suspicious' ? 'suspicious' : null,
      flagReason: it.flag === 'suspicious' ? str(it.flagReason, 140) || null : null,
      // A flagged item keeps no link at all.
      link: it.flag === 'suspicious' ? null : asLink(it.link),
      sender: asSender(it.sender),
      ask: str(it.ask, 160) || null,
      atISO: isoOrNull(it.atISO),
      checkedAt: isoOrNull(it.checkedAt) ?? isoOrNull(feed.updatedAt),
      trial: it.trial === true || /^personal-mail:/.test(id),
    });
  }
  return {
    label: str(feed.label, 40),
    updatedAt: isoOrNull(feed.updatedAt),
    items,
  };
}

// --------------------------------------------------------------------------
// Planning.

function noticeRank(r: RawItem, now: Date): number {
  const at = Date.parse(r.atISO ?? '');
  const ageDays = Number.isFinite(at) ? Math.max(0, (now.getTime() - at) / 86400000) : 14;
  // A flagged email always shows, so he knows to ignore it.
  return (r.flag ? 100 : 0) + r.impact - ageDays * 1.5;
}

function kindOf(raw: RawItem): TaskKind {
  if (raw.kind) return raw.kind;
  if (raw.source === 'schoology') return 'coursework';
  if (raw.source === 'manual') return 'errand';
  if (raw.source === 'project') return 'project';
  return raw.lane === 'aside' ? 'reply' : 'errand';
}

function trailRef(t: TrailEntry): TrailRef {
  return { title: t.title, kind: t.kind, url: t.url, lastAt: new Date(t.lastAt).toISOString(), minutes: t.minutes };
}

export function buildPlan(
  allRaws: RawItem[],
  user: NextUserState,
  sources: NextSourceStatus[],
  now: Date,
  trail: TrailEntry[] = [],
  context: LocalContext | null = null,
): NextPlan {
  const today = localDay(now);
  const raws = allRaws.filter((r) => kindOf(r) !== 'notice');
  const notices: NextNotice[] = allRaws
    .filter((r) => kindOf(r) === 'notice' && !r.resolved)
    .filter((r) => {
      const mark = user.items[r.id];
      return !(mark && (mark.status === 'done' || mark.status === 'dismissed'));
    })
    // Weight first, freshness second: a graded-essay note from last week
    // beats today's parking reminder, but not one from a month ago.
    .sort((a, b) => noticeRank(b, now) - noticeRank(a, now))
    // Up to three per space, so a busy school inbox never hides a personal one.
    .filter((r, i, arr) => arr.slice(0, i).filter((x) => spaceOf(x) === spaceOf(r)).length < 3)
    .map((r) => ({
      id: r.id,
      source: r.source,
      space: spaceOf(r),
      title: r.title,
      context: r.context,
      why: r.why,
      url: r.url,
      at: r.atISO ?? null,
      flag: r.flag ?? null,
      flagReason: r.flagReason ?? null,
      sender: r.sender ?? null,
    }));
  const items: NextItem[] = raws.map((raw) => {
    const mark = user.items[raw.id] ?? {};
    let status: NextStatus = 'open';
    let closedBy: NextItem['closedBy'] = null;
    let closedAt: string | null = null;
    let snoozedUntil: string | null = null;
    if (raw.resolved) {
      status = 'done';
      closedBy = mark.status === 'done' ? 'you' : 'source';
      closedAt = mark.at ?? null;
    } else if (mark.status === 'done') {
      status = 'done';
      closedBy = 'you';
      closedAt = mark.at ?? null;
    } else if (mark.status === 'dismissed') {
      status = 'dismissed';
    } else if (mark.status === 'handed-off') {
      status = 'handed-off';
    } else if (mark.status === 'snoozed' && mark.until && Date.parse(mark.until) > now.getTime()) {
      status = 'snoozed';
      snoozedUntil = mark.until;
    }
    const kept = mark.status === 'kept';
    const due = raw.dueISO ? Date.parse(raw.dueISO) : NaN;
    const kind = kindOf(raw);
    const taint = raw.taint ?? null;
    const flag = raw.flag ?? null;
    const overdue = Number.isFinite(due) && due < now.getTime();
    const checked = raw.checkedAt ? Date.parse(raw.checkedAt) : NaN;
    const records = context?.records.filter(r => r.taskId === raw.id) ?? [];
    const exact = records.find(r => r.kind === 'foreground-activity' && r.freshness === 'fresh');
    const hit = taint ? null : context ? (exact ? trail.find(t => t.key === exact.sourceId && trailKey(t.url)?.key === exact.sourceId && t.lastAt === Date.parse(exact.observedAt!)) ?? null : null) : matchTrail(raw, trail);
    const ref = hit ? { ...trailRef(hit), ...(context ? { title: raw.title, url: trailKey(hit.url)?.url ?? raw.url ?? hit.url } : {}) } : null;
    return {
      id: raw.id,
      source: raw.source,
      space: spaceOf(raw),
      title: raw.title,
      context: raw.context,
      dueISO: raw.dueISO,
      estMinutes: raw.estMinutes,
      lane: raw.lane,
      why: raw.why,
      url: raw.url,
      steps: raw.steps,
      // A flagged item never ranks on its own; it waits for a yes/no.
      confidence: flag ? Math.min(raw.confidence, 0.5) : kept ? 1 : raw.confidence,
      // New memory cannot add arbitrary points over a more urgent task.
      score: scoreItem(raw, now, context ? null : ref),
      overdue,
      lateConfirmed: overdue && Number.isFinite(checked) && checked > due,
      status,
      closedBy,
      closedAt,
      snoozedUntil,
      sessionId: mark.sessionId ?? null,
      kind,
      brief: briefFor({ ...raw, kind, taint, flag }),
      trail: ref,
      taint,
      flag,
      flagReason: raw.flagReason ?? null,
      link: raw.link ?? null,
      sender: raw.sender ?? null,
      ask: raw.ask ?? null,
      trial: Boolean(raw.trial) && !kept,
      draftedAt: mark.draftedAt ?? null,
      doneHint: raw.doneHint ?? null,
      ...(raw.alsoFrom?.length ? { alsoFrom: raw.alsoFrom } : {}),
      ...(raw.estBy ? { estBy: raw.estBy } : {}),
      ...(records.length ? { evidence: { revision: context?.revision ?? 0, records, influence: null } } : {}),
    };
  });

  const open = items
    .filter((it) => it.status === 'open')
    // An overdue item that no longer accepts work cannot be acted on.
    .filter((it) => {
      const raw = raws.find((r) => r.id === it.id);
      return !(it.overdue && raw && !raw.acceptsLate);
    })
    // Time-bound tasks ("bring the book", anything "in class") cannot be
    // done late: once the moment has passed they are noise.
    .filter((it) => {
      if (!it.overdue) return true;
      const pastMs = now.getTime() - Date.parse(it.dueISO!);
      if (/\b(bring|in class)\b/i.test(it.title) && pastMs > 2 * 3_600_000) return false;
      return !((it.estMinutes ?? 99) <= 10 && pastMs > 12 * 3_600_000);
    });
  // Personal Gmail on trial never ranks into Today until he keeps it.
  const review = open.filter((it) => it.trial).sort(byRank);
  const ranked = open.filter((it) => !it.trial);
  const recent = (it: NextItem) => it.evidence?.records.some(r => r.kind === 'foreground-activity' && r.freshness === 'fresh') ?? false;
  const samePriority = (a: NextItem, b: NextItem) => !a.overdue && !b.overdue && a.score === b.score && a.dueISO === b.dueISO && a.lane === b.lane && a.space === b.space;
  const confident = ranked.filter((it) => it.confidence >= UNSURE_BELOW).sort(byRank);
  if (context) {
    // Sort only within identical-priority slots. A conditional comparator
    // spanning different lanes can be non-transitive and shuffle urgent work.
    const groups = new Map<string, number[]>();
    confident.forEach((it, index) => {
      if (it.overdue) return;
      const key = JSON.stringify([it.score, it.dueISO, it.lane, it.space]);
      const positions = groups.get(key) ?? []; positions.push(index); groups.set(key, positions);
    });
    for (const positions of groups.values()) {
      const members = positions.map(i => confident[i]).sort((a, b) => Number(recent(b)) - Number(recent(a)) || byRank(a, b));
      positions.forEach((i, j) => { confident[i] = members[j]; });
    }
  }
  if (confident[0]?.evidence && recent(confident[0]) && confident.some(it => samePriority(confident[0], it) && !recent(it))) confident[0].evidence.influence = 'equal-priority-resume';
  const unsure = ranked.filter((it) => it.confidence < UNSURE_BELOW).sort(byRank);
  const now0 = confident[0] ?? null;
  const next = confident.slice(1, 1 + NEXT_COUNT);
  const later = confident.slice(1 + NEXT_COUNT);
  const doneToday = items
    .filter((it) => it.status === 'done')
    .filter((it) =>
      it.closedAt
        ? localDay(new Date(it.closedAt)) === today
        : it.dueISO
          ? localDay(new Date(it.dueISO)) === today
          : false,
    );
  const queuedMinutes = [now0, ...next].reduce((sum, it) => sum + (it?.estMinutes ?? 0), 0);
  const pick = trail.find(
    (t) =>
      (!context || context.records.some(r => r.kind === 'foreground-activity' && r.freshness === 'fresh' && r.sourceId === t.key)) &&
      t.minutes >= (/^Untitled/.test(t.title) ? 20 : 5) &&
      now.getTime() - t.lastAt < 36 * 3_600_000 &&
      t.url !== now0?.trail?.url &&
      t.kind !== 'Schoology',
  );
  return {
    generatedAt: now.toISOString(),
    now: now0,
    next,
    withAside: items.filter((it) => it.status === 'handed-off'),
    unsure: unsure.slice(0, 5),
    review: review.slice(0, 12),
    personalNote: null,
    later,
    doneToday,
    notices,
    pickUp: pick ? { ...trailRef(pick), ...(context ? { title: raws.find(r => context.records.some(e => e.taskId === r.id && e.kind === 'foreground-activity' && e.sourceId === pick.key))?.title ?? 'Matching task' } : {}) } : null,
    dayLine: dayLine(confident, doneToday.length, now),
    queuedMinutes,
    sources: sources.map((src) => ({ ...src, space: sourceSpace(src.id) })),
    refreshPrompt: null,
  };
}

// --------------------------------------------------------------------------
// The day line. Deterministic on purpose: it is read every time the screen
// opens, so it must be instant, free, and never wrong about a number.

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return 'Late night.';
  if (h < 12) return 'Morning.';
  if (h < 17) return 'Afternoon.';
  if (h < 22) return 'Evening.';
  return 'Late night.';
}

function words(n: number): string {
  return ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'][n] ?? String(n);
}

function hoursText(min: number): string {
  if (min < 50) return `about ${Math.max(5, Math.round(min / 5) * 5)} minutes`;
  const h = Math.round((min / 60) * 2) / 2;
  return h === 1 ? 'about an hour' : `about ${h} hours`;
}

export function dayLine(open: NextItem[], doneCount: number, now: Date): string {
  const hi = greeting(now);
  if (open.length === 0) {
    return doneCount ? `${hi} All clear, and ${doneCount} done today.` : `${hi} Nothing needs you right now.`;
  }
  const today = localDay(now);
  const late = open.filter((it) => it.overdue && it.lateConfirmed);
  const unsure = open.filter((it) => it.overdue && !it.lateConfirmed);
  const dueToday = open.filter((it) => !it.overdue && it.dueISO && localDay(new Date(it.dueISO)) === today);
  const minutes = dueToday.reduce((s, it) => s + (it.estMinutes ?? 0), 0);
  if (late.length) {
    const lead = late.length === 1 ? 'One thing is late' : `${words(late.length)} things are late`;
    return `${hi} ${lead}. Check ${late.length === 1 ? 'its' : 'their'} status.`;
  }
  if (unsure.length) {
    const lead =
      unsure.length === 1
        ? 'One thing passed its due date'
        : `${words(unsure.length)} things passed their due dates`;
    return `${hi} ${lead} without a check since. Make sure ${unsure.length === 1 ? 'it' : 'they'} went in.`;
  }
  if (dueToday.length === 1) {
    return now.getHours() >= 22
      ? `${hi} One thing is still due tonight.`
      : `${hi} One thing is due today${minutes ? `, ${hoursText(minutes)} of work` : ''}.`;
  }
  if (dueToday.length > 1) {
    return `${hi} ${words(dueToday.length)} things are due today${minutes ? `, ${hoursText(minutes)} in all` : ''}.`;
  }
  const nextDue = open
    .filter((it) => it.dueISO)
    .sort((a, b) => Date.parse(a.dueISO!) - Date.parse(b.dueISO!))[0];
  if (!nextDue) return `${hi} Nothing has a deadline today.`;
  const day = new Date(nextDue.dueISO!).toLocaleDateString('en-US', { weekday: 'long' });
  const tomorrow = localDay(new Date(now.getTime() + 86_400_000)) === localDay(new Date(nextDue.dueISO!));
  return `${hi} Nothing is due today. Next deadline is ${tomorrow ? 'tomorrow' : day}.`;
}

function byRank(a: NextItem, b: NextItem): number {
  if (b.score !== a.score) return b.score - a.score;
  const ad = a.dueISO ? Date.parse(a.dueISO) : Infinity;
  const bd = b.dueISO ? Date.parse(b.dueISO) : Infinity;
  if (ad === bd) return a.title.localeCompare(b.title);
  return ad - bd;
}

// --------------------------------------------------------------------------
// Disk. Reads are cheap (a few KB) and done per request so a routine's
// fresh write shows up on the next pull-to-refresh with no watcher.

export interface NextPaths {
  asideRoot: string;
  stateDir: string;
}

export function schoologyNotesPath(asideRoot: string): string {
  return path.join(asideRoot, 'skills/user/schoology-daily-planner/state/item-notes.json');
}

export function feedsDir(asideRoot: string): string {
  return path.join(asideRoot, 'next/feeds');
}

export function userStatePath(stateDir: string): string {
  return path.join(stateDir, 'next-state.json');
}

export function loadRaw(
  paths: NextPaths,
  now: Date,
): { raws: RawItem[]; sources: NextSourceStatus[] } {
  const raws: RawItem[] = [];
  const sources: NextSourceStatus[] = [];

  const notesPath = schoologyNotesPath(paths.asideRoot);
  if (fs.existsSync(notesPath)) {
    try {
      const doc = JSON.parse(fs.readFileSync(notesPath, 'utf8')) as {
        items?: Record<string, SchoologyNote>;
        excludedCourses?: Record<string, unknown>;
        schoologyBase?: unknown;
      };
      const items = adaptSchoology(
        doc.items ?? {},
        new Set(Object.keys(doc.excludedCourses ?? {})),
        now,
        httpsOrNull(doc.schoologyBase) ?? httpsOrNull(process.env.MINIAPP_SCHOOLOGY_BASE),
      );
      raws.push(...items);
      sources.push({
        id: 'schoology',
        label: 'Schoology',
        updatedAt: fs.statSync(notesPath).mtime.toISOString(),
        count: items.length,
        ok: true,
      });
    } catch {
      sources.push({
        id: 'schoology',
        label: 'Schoology',
        updatedAt: null,
        count: 0,
        ok: false,
      });
    }
  }

  const dir = feedsDir(paths.asideRoot);
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /^[\w-]+\.json$/.test(f))
      .sort();
  } catch {
    files = [];
  }
  const personalOn = readPersonalMailConfig(paths.asideRoot) !== null;
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    if (id === 'personal-mail' && !personalOn) continue;
    try {
      const feed = adaptFeed(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
      const allowedItems = personalOn ? feed.items : feed.items.filter(r => r.source !== 'mail');
      raws.push(...allowedItems);
      sources.push({
        id,
        label: feed.label || capitalise(id.replace(/-/g, ' ')),
        updatedAt: feed.updatedAt ?? fs.statSync(path.join(dir, file)).mtime.toISOString(),
        count: allowedItems.length,
        ok: true,
      });
    } catch {
      sources.push({
        id,
        label: capitalise(id),
        updatedAt: null,
        count: 0,
        ok: false,
      });
    }
  }

  // Two producers can describe the same thing; the first one wins.
  const seen = new Set<string>();
  return {
    raws: raws.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))),
    sources,
  };
}

export class NextStore {
  /** Applied to every raw list before planning or prompt building (nextjev.ts hints). */
  private transform: (raws: RawItem[]) => RawItem[] = (r) => r;

  readonly contextMemory: ContextMemory;
  constructor(private readonly paths: NextPaths) { this.contextMemory = new ContextMemory(paths.asideRoot); }

  useTransform(fn: (raws: RawItem[]) => RawItem[]): void {
    this.transform = fn;
  }

  readUser(): NextUserState {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(userStatePath(this.paths.stateDir), 'utf8'),
      ) as NextUserState;
      return parsed && typeof parsed.items === 'object' && parsed.items ? parsed : { items: {} };
    } catch {
      return { items: {} };
    }
  }

  plan(now = new Date(), trail: TrailEntry[] = [], extra: RawItem[] = [], raw = false, suppressContext = false): NextPlan {
    const { raws, sources } = loadRaw(this.paths, now);
    const all = [...extra, ...raws];
    let context = suppressContext ? null : buildLocalContext(readContextPolicy(this.paths.asideRoot), all, trail, now);
    let memoryEnabled = false;
    try {
      const memory = this.contextMemory.status(now);
      memoryEnabled = memory.preferences.enabled;
      if (memoryEnabled) context = suppressContext ? null : this.contextMemory.project(all, trail, memory.revision, now);
    } catch { context = null; memoryEnabled = true; /* Fail closed on new context, not the whole planner. */ }
    return {
      ...buildPlan(raw ? all : this.transform(all), this.readUser(), sources, now, suppressContext || (memoryEnabled && !context) ? [] : trail, memoryEnabled ? context : null),
      refreshPrompt: this.refreshPrompt(),
      ...(context ? { context } : {}),
    };
  }

  /** The raw record behind an id, for building a server-side agent prompt. */
  rawFor(id: string, now = new Date(), extra: RawItem[] = []): RawItem | null {
    return this.transform([...extra, ...loadRaw(this.paths, now).raws]).find((r) => r.id === id) ?? null;
  }

  /** Every raw item as loaded, before hints (for the Jev worker). */
  rawAll(now = new Date(), extra: RawItem[] = []): RawItem[] {
    return [...extra, ...loadRaw(this.paths, now).raws];
  }

  private refreshPrompt(): string | null {
    const file = path.join(this.paths.asideRoot, 'next/inbox-sweep.md');
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 16_000) return null;
      // Point at the file rather than inlining it, so the session transcript
      // stays short and the routine and the button share one source of truth.
      return `Run the Next inbox sweep exactly as written in ${file}. Read that file first and follow it; it defines the only file you may write and forbids any action in Gmail.`;
    } catch {
      return null;
    }
  }

  apply(id: string, action: NextAction, now = new Date()): void {
    const state = this.readUser();
    const at = now.toISOString();
    switch (action.type) {
      case 'done':
        state.items[id] = { status: 'done', at };
        break;
      case 'dismiss':
        state.items[id] = { status: 'dismissed', at };
        break;
      case 'keep':
        state.items[id] = { status: 'kept', at };
        break;
      case 'snooze':
        state.items[id] = { status: 'snoozed', at, until: action.until };
        break;
      case 'handoff':
        state.items[id] = {
          status: 'handed-off',
          at,
          sessionId: action.sessionId,
        };
        break;
      case 'reopen':
        delete state.items[id];
        break;
    }
    // Forget marks older than 60 days so the file cannot grow forever.
    const cutoff = now.getTime() - 60 * 24 * 60 * 60 * 1000;
    for (const [key, mark] of Object.entries(state.items)) {
      if (mark.at && Date.parse(mark.at) < cutoff) delete state.items[key];
    }
    this.writeUser(state);
  }

  private writeUser(state: NextUserState): void {
    const file = userStatePath(this.paths.stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  }
}

export type NextAction =
  | { type: 'done' }
  | { type: 'dismiss' }
  | { type: 'keep' }
  | { type: 'reopen' }
  | { type: 'snooze'; until: string }
  | { type: 'handoff'; sessionId: string };

export function parseAction(body: unknown): NextAction | null {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (b.type) {
    case 'done':
    case 'dismiss':
    case 'keep':
    case 'reopen':
      return { type: b.type };
    case 'snooze': {
      const until = isoOrNull(b.until);
      return until ? { type: 'snooze', until } : null;
    }
    case 'handoff': {
      const sessionId = str(b.sessionId, 80);
      return /^[\w-]{6,80}$/.test(sessionId) ? { type: 'handoff', sessionId } : null;
    }
    default:
      return null;
  }
}

export function isValidNextId(id: string): boolean {
  return id.length <= 140 && /^[\w:.@<>+\-/=]+$/.test(id);
}

// --------------------------------------------------------------------------
// Small, strict coercions.

function str(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Collapse whitespace and strip control characters; text only.
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => str(v, MAX_TEXT))
    .filter(Boolean)
    .slice(0, MAX_STEPS);
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function httpsOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function asLane(value: unknown): NextLane | null {
  return value === 'you' || value === 'prep' || value === 'aside' ? value : null;
}

function asKind(value: unknown): TaskKind | null {
  return value === 'coursework' ||
    value === 'reply' ||
    value === 'form' ||
    value === 'schedule' ||
    value === 'event' ||
    value === 'notice' ||
    value === 'errand' ||
    value === 'opportunity' ||
    value === 'project'
    ? value
    : null;
}

function asLink(value: unknown): ItemLink | null {
  const l = (value ?? null) as Record<string, unknown> | null;
  if (!l || typeof l !== 'object') return null;
  const url = httpsOrNull(l.url);
  if (!url) return null;
  const host = new URL(url).hostname.replace(/^www\./, '');
  // The host shown is recomputed from the URL, never taken from the file.
  return { url, host, verified: l.verified === true, reason: str(l.reason, 60) };
}

function asSender(value: unknown): ItemSender | null {
  const v = (value ?? null) as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return null;
  const host = str(v.host, 80).toLowerCase();
  if (!host) return null;
  const tier = v.tier === 'district' || v.tier === 'student' ? v.tier : 'outside';
  return { name: str(v.name, 50), host, school: tier === 'district', tier };
}

function asSource(value: unknown): NextSource | null {
  return value === 'schoology' ||
    value === 'school-mail' ||
    value === 'mail' ||
    value === 'calendar' ||
    value === 'manual'
    ? value
    : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
