/**
 * Projects: long-running goals with a plan he can trust.
 *
 * The split of labour matches the rest of Next:
 *
 *  - A model may PROPOSE what the steps are (the inspector reads his
 *    memory, Common App, and docs, then returns JSON). A proposal is data:
 *    it is validated, capped, diffed against the current plan, and shown on
 *    the phone. Nothing changes until he taps Apply.
 *  - Code decides WHEN. The schedule below is plain arithmetic over the
 *    steps, their effort, their order, his daily capacity, and the clock:
 *    a backward pass finds the latest each step can finish without missing
 *    the deadline, and a forward pass fills his real days, least slack
 *    first. No model call, so the dates are never a guess dressed as a
 *    fact, and the same inputs always give the same plan.
 *
 * Steps that came from a model are marked `origin: 'inspector'`. They can
 * never start an agent: project steps are his to do (brief kind 'project').
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type MilestoneStatus = 'todo' | 'doing' | 'done' | 'blocked';
export type MilestoneOwner = 'you' | 'wait';

export interface Milestone {
  id: string;
  title: string;
  /** One or two sentences: what "done" looks like. */
  detail: string;
  estMinutes: number;
  dependsOn: string[];
  status: MilestoneStatus;
  /** 'wait' = someone else has to act (a letter, a reply); his part is the nudge. */
  owner: MilestoneOwner;
  /** A hard date of its own (a school's early deadline), end of that day. */
  fixedDueISO: string | null;
  /** Why this step exists: the evidence behind it, in plain words. */
  evidence: string;
  url: string | null;
  origin: 'you' | 'inspector';
  doneAt: string | null;
}

export interface Capacity {
  /** Minutes he can realistically give this project on a school day. */
  weekdayMin: number;
  weekendMin: number;
}

export interface Finding {
  text: string;
  source: string;
}

export interface Proposal {
  id: string;
  createdAt: string;
  sessionId: string | null;
  summary: string;
  findings: Finding[];
  milestones: Milestone[];
}

export interface Project {
  id: string;
  title: string;
  goal: string;
  deadlineISO: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'done' | 'archived';
  /** School or personal. Old projects without one count as personal. */
  space: 'school' | 'personal';
  capacity: Capacity;
  milestones: Milestone[];
  inspect: {
    state: 'idle' | 'running' | 'failed';
    sessionId: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  };
  proposal: Proposal | null;
}

// --------------------------------------------------------------------------
// Limits. Everything from disk or a model is re-checked against these.

const MAX_PROJECTS = 12;
const MAX_MILESTONES = 40;
const MAX_TITLE = 90;
const MAX_TEXT = 280;
const MAX_FINDINGS = 12;
const MIN_EST = 5;
const MAX_EST = 2400;
const MIN_CHUNK = 20;
export const DEFAULT_CAPACITY: Capacity = { weekdayMin: 90, weekendMin: 180 };

// --------------------------------------------------------------------------
// Coercion.

const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function httpsOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** "2026-10-15" means the end of that local day. */
export function endOfDayISO(value: unknown): string | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    const at = new Date(y, m - 1, d, 23, 59, 0, 0);
    return Number.isFinite(at.getTime()) ? at.toISOString() : null;
  }
  return isoOrNull(value);
}

function slugId(value: unknown, fallback: string): string {
  const s = clean(value, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

export function asMilestone(value: unknown, i: number, origin: Milestone['origin']): Milestone | null {
  const v = (value ?? null) as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return null;
  const title = clean(v.title, MAX_TITLE);
  if (!title) return null;
  const est = Number(v.estMinutes);
  const status: MilestoneStatus =
    v.status === 'doing' || v.status === 'done' || v.status === 'blocked' ? v.status : 'todo';
  return {
    id: slugId(v.id, `step-${i + 1}`),
    title,
    detail: clean(v.detail, MAX_TEXT),
    estMinutes: Number.isFinite(est) ? Math.round(Math.min(MAX_EST, Math.max(MIN_EST, est))) : 60,
    dependsOn: Array.isArray(v.dependsOn)
      ? v.dependsOn.slice(0, 8).map((d) => slugId(d, '')).filter(Boolean)
      : [],
    status,
    owner: v.owner === 'wait' ? 'wait' : 'you',
    fixedDueISO: endOfDayISO(v.fixedDueISO ?? v.fixedDue ?? null),
    evidence: clean(v.evidence, MAX_TEXT),
    url: httpsOrNull(v.url),
    origin: v.origin === 'you' || v.origin === 'inspector' ? v.origin : origin,
    doneAt: status === 'done' ? isoOrNull(v.doneAt) : null,
  };
}

/**
 * Validate a list of steps: unique ids, dependencies that exist, and no
 * cycles (a cycle would make "what comes first" meaningless). Returns the
 * cleaned list; bad edges are dropped, not guessed at.
 */
export function cleanMilestones(list: unknown, origin: Milestone['origin']): Milestone[] {
  if (!Array.isArray(list)) return [];
  const out: Milestone[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of list.slice(0, MAX_MILESTONES).entries()) {
    const m = asMilestone(raw, i, origin);
    if (!m) continue;
    let id = m.id;
    for (let n = 2; seen.has(id); n++) id = `${m.id}-${n}`;
    seen.add(id);
    out.push({ ...m, id });
  }
  const ids = new Set(out.map((m) => m.id));
  for (const m of out) m.dependsOn = [...new Set(m.dependsOn)].filter((d) => d !== m.id && ids.has(d));
  // Break cycles: walk in list order and keep only edges to steps already
  // accepted as acyclic. List order is the author's intended sequence.
  const byId = new Map(out.map((m) => [m.id, m]));
  const reaches = (from: string, target: string, seenIds = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seenIds.has(from)) return false;
    seenIds.add(from);
    return (byId.get(from)?.dependsOn ?? []).some((d) => reaches(d, target, seenIds));
  };
  for (const m of out) {
    const keep: string[] = [];
    for (const d of m.dependsOn) {
      const prev = m.dependsOn;
      m.dependsOn = keep;
      if (!reaches(d, m.id)) keep.push(d);
      m.dependsOn = prev;
    }
    m.dependsOn = keep;
  }
  return out;
}

export function asCapacity(value: unknown): Capacity {
  const v = (value ?? {}) as Record<string, unknown>;
  const n = (x: unknown, d: number) => {
    const k = Number(x);
    return Number.isFinite(k) ? Math.round(Math.min(720, Math.max(0, k))) : d;
  };
  return { weekdayMin: n(v.weekdayMin, DEFAULT_CAPACITY.weekdayMin), weekendMin: n(v.weekendMin, DEFAULT_CAPACITY.weekendMin) };
}

function asProject(value: unknown): Project | null {
  const v = (value ?? null) as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return null;
  const id = typeof v.id === 'string' && /^[a-z0-9-]{3,40}$/.test(v.id) ? v.id : null;
  const title = clean(v.title, MAX_TITLE);
  const deadlineISO = isoOrNull(v.deadlineISO);
  if (!id || !title || !deadlineISO) return null;
  const ins = (v.inspect ?? {}) as Record<string, unknown>;
  const prop = (v.proposal ?? null) as Record<string, unknown> | null;
  return {
    id,
    title,
    goal: clean(v.goal, MAX_TEXT),
    deadlineISO,
    createdAt: isoOrNull(v.createdAt) ?? new Date(0).toISOString(),
    updatedAt: isoOrNull(v.updatedAt) ?? new Date(0).toISOString(),
    status: v.status === 'done' || v.status === 'archived' ? v.status : 'active',
    space: v.space === 'school' ? 'school' : 'personal',
    capacity: asCapacity(v.capacity),
    milestones: cleanMilestones(v.milestones, 'you'),
    inspect: {
      state: ins.state === 'running' || ins.state === 'failed' ? ins.state : 'idle',
      sessionId: typeof ins.sessionId === 'string' && /^[\w-]{6,80}$/.test(ins.sessionId) ? ins.sessionId : null,
      startedAt: isoOrNull(ins.startedAt),
      finishedAt: isoOrNull(ins.finishedAt),
      error: clean(ins.error, 160) || null,
    },
    proposal: prop && typeof prop === 'object' ? asProposal(prop, typeof prop.sessionId === 'string' ? prop.sessionId : null) : null,
  };
}

/**
 * A proposal from the inspector. Its text came from a model that read web
 * pages, so every field is re-cleaned and capped, URLs must be https, and
 * the result is only ever displayed or, after his tap, stored as steps.
 */
export function asProposal(value: unknown, sessionId: string | null, now = new Date()): Proposal | null {
  const v = (value ?? null) as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return null;
  const milestones = cleanMilestones(v.milestones, 'inspector');
  if (!milestones.length) return null;
  const findings = Array.isArray(v.findings)
    ? v.findings
        .slice(0, MAX_FINDINGS)
        .map((f) => {
          const o = (f ?? {}) as Record<string, unknown>;
          return { text: clean(o.text, 220), source: clean(o.source, 80) };
        })
        .filter((f) => f.text)
    : [];
  return {
    id: typeof v.id === 'string' && /^[a-f0-9]{8,16}$/.test(v.id) ? v.id : crypto.randomBytes(4).toString('hex'),
    createdAt: isoOrNull(v.createdAt) ?? now.toISOString(),
    sessionId: sessionId && /^[\w-]{6,80}$/.test(sessionId) ? sessionId : null,
    summary: clean(v.summary, 420),
    findings,
    milestones,
  };
}

/** Pull the last fenced ```json block out of an agent's final message. */
export function extractJsonBlock(text: string): unknown {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last || last.length > 60_000) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Diff: what applying a proposal would change, in words he can scan.

export interface ProposalDiff {
  added: Array<{ id: string; title: string }>;
  removed: Array<{ id: string; title: string }>;
  changed: Array<{ id: string; title: string; what: string[] }>;
  kept: number;
}

function sameStep(a: Milestone, b: Milestone): boolean {
  if (a.id === b.id) return true;
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const wa = words(a.title);
  const wb = words(b.title);
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.75;
}

export function diffProposal(current: Milestone[], proposed: Milestone[]): ProposalDiff {
  const used = new Set<string>();
  const out: ProposalDiff = { added: [], removed: [], changed: [], kept: 0 };
  for (const p of proposed) {
    const c = current.find((m) => !used.has(m.id) && sameStep(m, p));
    if (!c) {
      out.added.push({ id: p.id, title: p.title });
      continue;
    }
    used.add(c.id);
    const what: string[] = [];
    if (c.estMinutes !== p.estMinutes) what.push(`effort ${hm(c.estMinutes)} to ${hm(p.estMinutes)}`);
    if ((c.fixedDueISO ?? '') !== (p.fixedDueISO ?? '')) what.push(p.fixedDueISO ? `must be done by ${shortDate(p.fixedDueISO)}` : 'no longer has its own date');
    if (c.status !== p.status && p.status !== 'todo') what.push(`marked ${p.status}`);
    if (c.owner !== p.owner) what.push(p.owner === 'wait' ? 'now waiting on someone' : 'now yours');
    if (c.title !== p.title) what.push('renamed');
    if (what.length) out.changed.push({ id: c.id, title: p.title, what });
    else out.kept++;
  }
  for (const c of current) if (!used.has(c.id) && c.status !== 'done') out.removed.push({ id: c.id, title: c.title });
  return out;
}

/**
 * Apply a proposal. Work he already finished stays finished: a matching
 * step keeps its done status and date even if the proposal says todo, and
 * finished steps the proposal dropped are kept as history.
 */
export function mergeProposal(current: Milestone[], proposed: Milestone[]): Milestone[] {
  const used = new Set<string>();
  const merged = proposed.map((p) => {
    const c = current.find((m) => !used.has(m.id) && sameStep(m, p));
    if (!c) return p;
    used.add(c.id);
    const done = c.status === 'done' || p.status === 'done';
    return { ...p, id: c.id, status: done ? 'done' : p.status, doneAt: done ? (c.doneAt ?? p.doneAt) : null, origin: c.origin === 'you' ? 'you' : p.origin } as Milestone;
  });
  // Dependencies pointed at proposal ids; remap to the kept ids.
  const remap = new Map<string, string>();
  proposed.forEach((p, i) => remap.set(p.id, merged[i].id));
  for (const m of merged) m.dependsOn = m.dependsOn.map((d) => remap.get(d) ?? d);
  const history = current.filter((c) => !used.has(c.id) && c.status === 'done');
  return cleanMilestones([...history, ...merged], 'inspector');
}

// --------------------------------------------------------------------------
// The schedule. Deterministic.

export interface DayPlan {
  day: string;
  capacity: number;
  minutes: number;
  items: Array<{ id: string; title: string; minutes: number; critical: boolean }>;
}

export interface MilestoneView extends Milestone {
  plannedStart: string | null;
  plannedFinish: string | null;
  latestFinish: string | null;
  slackDays: number | null;
  critical: boolean;
  atRisk: boolean;
  ready: boolean;
  remainingMin: number;
}

export type ProjectHealth = 'on-track' | 'tight' | 'at-risk' | 'done' | 'empty';

export interface ProjectView {
  id: string;
  title: string;
  goal: string;
  deadlineISO: string;
  status: Project['status'];
  space: Project['space'];
  health: ProjectHealth;
  /** One sentence, from the numbers. */
  line: string;
  daysLeft: number;
  bufferDays: number;
  targetFinish: string;
  projectedFinish: string | null;
  remainingMin: number;
  capacityMin: number;
  shortMin: number;
  done: number;
  total: number;
  capacity: Capacity;
  today: DayPlan | null;
  days: DayPlan[];
  milestones: MilestoneView[];
  waiting: MilestoneView[];
  inspect: Project['inspect'];
  proposal: (Proposal & { diff: ProposalDiff; preview: ProposalPreview }) | null;
  updatedAt: string;
}

/** What the plan would look like if he applied the proposal now. */
export interface ProposalPreview {
  health: ProjectHealth;
  line: string;
  projectedFinish: string | null;
  remainingMin: number;
  /** Steps whose own hard date falls after the project deadline. */
  pastDeadline: string[];
}

export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

function dayIndex(from: Date, iso: string): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const t = new Date(iso);
  const b = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

function isWeekend(d: Date): boolean {
  const w = d.getDay();
  return w === 0 || w === 6;
}

/**
 * Minutes available on day i. Today only counts what is left of his
 * working window (3-11 PM on school days, 9 AM-11 PM on weekends), so a
 * plan made at 10 PM does not pretend the evening is still ahead.
 */
export function capacityOn(i: number, now: Date, cap: Capacity): number {
  const d = addDays(now, i);
  const full = isWeekend(d) ? cap.weekendMin : cap.weekdayMin;
  if (i > 0) return full;
  const start = isWeekend(d) ? 9 : 15;
  const end = 23;
  const h = now.getHours() + now.getMinutes() / 60;
  if (h <= start) return full;
  if (h >= end) return 0;
  return Math.round((full * (end - h)) / (end - start));
}

function hm(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function scheduleProject(p: Project, now: Date): ProjectView {
  const deadlineIdx = Math.max(0, dayIndex(now, p.deadlineISO));
  const daysLeft = deadlineIdx;
  // Keep a buffer before the deadline: 15% of the days left, at least one
  // when there is room. Late surprises (a portal down, a letter late) land
  // in the buffer instead of on the deadline.
  const bufferDays = deadlineIdx >= 3 ? Math.max(1, Math.round(deadlineIdx * 0.15)) : 0;
  const targetIdx = deadlineIdx - bufferDays;
  const open = p.milestones.filter((m) => m.status !== 'done');
  const done = p.milestones.length - open.length;
  const byId = new Map(p.milestones.map((m) => [m.id, m]));
  const succ = new Map<string, string[]>();
  for (const m of p.milestones) for (const d of m.dependsOn) succ.set(d, [...(succ.get(d) ?? []), m.id]);

  const cap = (i: number) => capacityOn(i, now, p.capacity);
  let capacityMin = 0;
  for (let i = 0; i <= deadlineIdx; i++) capacityMin += cap(i);

  // Backward pass: the latest day each step can finish and still leave its
  // successors enough of his real capacity to finish by the target day.
  const lf = new Map<string, number>();
  const ls = new Map<string, number>();
  const latestStart = (endIdx: number, minutes: number) => {
    let left = minutes;
    let i = endIdx;
    for (; i >= 0 && left > 0; i--) left -= Math.max(cap(i), 0);
    return left > 0 ? i : i + 1;
  };
  const visit = (id: string, stack = new Set<string>()): number => {
    if (lf.has(id)) return lf.get(id)!;
    const m = byId.get(id)!;
    stack.add(id);
    let finish = targetIdx;
    if (m.fixedDueISO) finish = Math.min(finish, dayIndex(now, m.fixedDueISO));
    for (const s of succ.get(id) ?? []) {
      if (stack.has(s) || byId.get(s)?.status === 'done') continue;
      visit(s, stack);
      finish = Math.min(finish, ls.get(s)!);
    }
    stack.delete(id);
    lf.set(id, finish);
    ls.set(id, m.status === 'done' ? finish : latestStart(finish, m.estMinutes));
    return finish;
  };
  for (const m of p.milestones) visit(m.id);

  // Forward pass: fill real days, least slack first, never a sliver under
  // 20 minutes unless that finishes the step.
  const remaining = new Map(open.map((m) => [m.id, m.status === 'blocked' ? 0 : m.estMinutes]));
  const finishedOn = new Map<string, number>();
  const startedOn = new Map<string, number>();
  const days: DayPlan[] = [];
  const horizon = Math.max(deadlineIdx + 45, 14);
  const isDone = (id: string) => byId.get(id)?.status === 'done';
  for (let i = 0; i <= horizon && [...remaining.values()].some((v) => v > 0); i++) {
    let left = cap(i);
    const plan: DayPlan = { day: dayKey(addDays(now, i)), capacity: left, minutes: 0, items: [] };
    const ready = () =>
      open
        .filter((m) => (remaining.get(m.id) ?? 0) > 0)
        .filter((m) => m.dependsOn.every((d) => isDone(d) || (finishedOn.has(d) && finishedOn.get(d)! <= i)))
        .sort(
          (a, b) =>
            (ls.get(a.id)! - ls.get(b.id)!) ||
            (lf.get(a.id)! - lf.get(b.id)!) ||
            p.milestones.indexOf(a) - p.milestones.indexOf(b),
        );
    let guard = 0;
    while (left > 0 && guard++ < 50) {
      const next = ready().find((m) => {
        const r = remaining.get(m.id)!;
        return r <= left || left >= MIN_CHUNK;
      });
      if (!next) break;
      const r = remaining.get(next.id)!;
      const take = Math.min(r, left);
      remaining.set(next.id, r - take);
      left -= take;
      if (!startedOn.has(next.id)) startedOn.set(next.id, i);
      if (r - take <= 0) finishedOn.set(next.id, i);
      const slack = lf.get(next.id)! - i;
      const existing = plan.items.find((x) => x.id === next.id);
      if (existing) existing.minutes += take;
      else plan.items.push({ id: next.id, title: next.title, minutes: take, critical: slack <= 0 });
      plan.minutes += take;
    }
    days.push(plan);
  }

  const views: MilestoneView[] = p.milestones.map((m) => {
    const fin = finishedOn.get(m.id);
    const latest = lf.get(m.id)!;
    const slack = fin !== undefined ? latest - fin : null;
    const unscheduled = m.status !== 'done' && m.status !== 'blocked' && fin === undefined;
    const atRisk =
      m.status !== 'done' &&
      (unscheduled || (fin !== undefined && (fin > deadlineIdx || (m.fixedDueISO ? fin > dayIndex(now, m.fixedDueISO) : false))));
    return {
      ...m,
      plannedStart: startedOn.has(m.id) ? dayKey(addDays(now, startedOn.get(m.id)!)) : null,
      plannedFinish: fin !== undefined ? dayKey(addDays(now, fin)) : null,
      latestFinish: m.status === 'done' ? null : dayKey(addDays(now, Math.max(latest, 0))),
      slackDays: m.status === 'done' ? null : slack,
      critical: m.status !== 'done' && slack !== null && slack <= 0,
      atRisk,
      ready: m.dependsOn.every((d) => isDone(d)),
      remainingMin: m.status === 'done' ? 0 : m.estMinutes,
    };
  });

  const remainingMin = open.filter((m) => m.status !== 'blocked').reduce((s, m) => s + m.estMinutes, 0);
  const lastFinish = Math.max(-1, ...[...finishedOn.values()]);
  const unscheduled = open.some((m) => m.status !== 'blocked' && !finishedOn.has(m.id));
  const projectedIdx = unscheduled ? null : lastFinish;
  let shortMin = 0;
  if (remainingMin > capacityMin) shortMin = remainingMin - capacityMin;
  else if (projectedIdx !== null && projectedIdx > deadlineIdx) {
    for (const d of days) if (dayIndex(now, new Date(d.day + 'T12:00:00').toISOString()) > deadlineIdx) shortMin += d.minutes;
  }
  let health: ProjectHealth;
  if (!p.milestones.length) health = 'empty';
  else if (!open.length) health = 'done';
  else if (projectedIdx === null || projectedIdx > deadlineIdx || views.some((v) => v.atRisk)) health = 'at-risk';
  else if (projectedIdx > targetIdx) health = 'tight';
  else health = 'on-track';

  const projectedFinish = projectedIdx !== null && projectedIdx >= 0 ? dayKey(addDays(now, projectedIdx)) : null;
  const targetFinish = dayKey(addDays(now, Math.max(targetIdx, 0)));
  const waiting = views.filter((v) => v.owner === 'wait' && v.status !== 'done');
  let proposal: ProjectView['proposal'] = null;
  if (p.proposal) {
    const merged = mergeProposal(p.milestones, p.proposal.milestones);
    const after = scheduleProject({ ...p, milestones: merged, proposal: null }, now);
    proposal = {
      ...p.proposal,
      diff: diffProposal(p.milestones, p.proposal.milestones),
      preview: {
        health: after.health,
        line: after.line,
        projectedFinish: after.projectedFinish,
        remainingMin: after.remainingMin,
        pastDeadline: merged
          .filter((m) => m.status !== 'done' && m.fixedDueISO && Date.parse(m.fixedDueISO) > Date.parse(p.deadlineISO))
          .map((m) => m.title),
      },
    };
  }
  const blocked = views.filter((v) => v.status === 'blocked').length;
  return {
    id: p.id,
    title: p.title,
    goal: p.goal,
    deadlineISO: p.deadlineISO,
    status: p.status,
    space: p.space,
    health,
    line: healthLine(health, { projectedFinish, shortMin, bufferDays, remainingMin, capacityMin, daysLeft, blocked }),
    daysLeft,
    bufferDays,
    targetFinish,
    projectedFinish,
    remainingMin,
    capacityMin,
    shortMin,
    done,
    total: p.milestones.length,
    capacity: p.capacity,
    today: days[0] && days[0].items.length ? days[0] : null,
    days: days.slice(0, Math.max(deadlineIdx + 1, 7)),
    milestones: views,
    waiting,
    inspect: p.inspect,
    proposal,
    updatedAt: p.updatedAt,
  };
}

function healthLine(
  h: ProjectHealth,
  x: { projectedFinish: string | null; shortMin: number; bufferDays: number; remainingMin: number; capacityMin: number; daysLeft: number; blocked: number },
): string {
  const fin = x.projectedFinish ? shortDate(`${x.projectedFinish}T12:00:00`) : null;
  const blocked = x.blocked ? ` ${x.blocked} blocked step${x.blocked === 1 ? '' : 's'} not counted.` : '';
  switch (h) {
    case 'empty':
      return 'No steps yet. Inspect it, or add the first step.';
    case 'done':
      return 'Every step is done.';
    case 'on-track':
      return `On track to finish ${fin}, with ${x.bufferDays} spare day${x.bufferDays === 1 ? '' : 's'}.${blocked}`;
    case 'tight':
      return `Finishes ${fin}, inside the buffer. One slow day makes it late.${blocked}`;
    case 'at-risk':
      return x.shortMin > 0
        ? `About ${hm(x.shortMin)} more work than time. Add time, cut a step, or move the date.${blocked}`
        : `A step misses its date as planned. Check the red steps.${blocked}`;
  }
}

// --------------------------------------------------------------------------
// Store.

export interface NewProject {
  title: string;
  goal: string;
  deadline: string;
  capacity?: Partial<Capacity>;
  milestones?: unknown[];
  space?: unknown;
}

export class ProjectStore {
  constructor(private readonly file: string) {}

  list(): Project[] {
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { projects?: unknown[] };
      return (doc.projects ?? []).map(asProject).filter((p): p is Project => p !== null).slice(0, MAX_PROJECTS);
    } catch {
      return [];
    }
  }

  get(id: string): Project | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  private write(projects: Project[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private mutate(id: string, fn: (p: Project) => Project | null, now = new Date()): Project | null {
    const all = this.list();
    const i = all.findIndex((p) => p.id === id);
    if (i < 0) return null;
    const next = fn(structuredClone(all[i]));
    if (!next) return null;
    next.updatedAt = now.toISOString();
    all[i] = next;
    this.write(all);
    return next;
  }

  create(input: NewProject, now = new Date()): Project | { error: string } {
    const title = clean(input.title, MAX_TITLE);
    const deadlineISO = endOfDayISO(input.deadline);
    if (!title) return { error: 'title_required' };
    if (!deadlineISO || Date.parse(deadlineISO) < now.getTime() - 86_400_000) return { error: 'bad_deadline' };
    const all = this.list();
    if (all.filter((p) => p.status !== 'archived').length >= MAX_PROJECTS) return { error: 'too_many' };
    let id = slugId(title, 'project').slice(0, 32);
    if (id.length < 3) id = `project-${id}`;
    for (let n = 2; all.some((p) => p.id === id); n++) id = `${slugId(title, 'project').slice(0, 28)}-${n}`;
    const at = now.toISOString();
    const project: Project = {
      id,
      title,
      goal: clean(input.goal, MAX_TEXT),
      deadlineISO,
      createdAt: at,
      updatedAt: at,
      status: 'active',
      space: input.space === 'school' ? 'school' : 'personal',
      capacity: asCapacity(input.capacity ?? {}),
      milestones: cleanMilestones(input.milestones ?? [], 'you'),
      inspect: { state: 'idle', sessionId: null, startedAt: null, finishedAt: null, error: null },
      proposal: null,
    };
    this.write([...all, project]);
    return project;
  }

  update(id: string, patch: { title?: string; goal?: string; deadline?: string; capacity?: Partial<Capacity>; status?: Project['status']; space?: Project['space'] }, now = new Date()) {
    return this.mutate(id, (p) => {
      if (patch.space === 'school' || patch.space === 'personal') p.space = patch.space;
      if (patch.title !== undefined) p.title = clean(patch.title, MAX_TITLE) || p.title;
      if (patch.goal !== undefined) p.goal = clean(patch.goal, MAX_TEXT);
      if (patch.deadline !== undefined) p.deadlineISO = endOfDayISO(patch.deadline) ?? p.deadlineISO;
      if (patch.capacity) p.capacity = asCapacity({ ...p.capacity, ...patch.capacity });
      if (patch.status === 'active' || patch.status === 'done' || patch.status === 'archived') p.status = patch.status;
      return p;
    }, now);
  }

  setMilestone(id: string, mid: string, patch: { status?: MilestoneStatus; estMinutes?: number; title?: string }, now = new Date()) {
    return this.mutate(id, (p) => {
      const m = p.milestones.find((x) => x.id === mid);
      if (!m) return null;
      if (patch.status) {
        m.status = patch.status;
        m.doneAt = patch.status === 'done' ? now.toISOString() : null;
      }
      if (patch.estMinutes !== undefined && Number.isFinite(patch.estMinutes)) {
        m.estMinutes = Math.round(Math.min(MAX_EST, Math.max(MIN_EST, patch.estMinutes)));
      }
      if (patch.title !== undefined) m.title = clean(patch.title, MAX_TITLE) || m.title;
      return p;
    }, now);
  }

  addMilestone(id: string, input: unknown, now = new Date()) {
    return this.mutate(id, (p) => {
      if (p.milestones.length >= MAX_MILESTONES) return null;
      const m = asMilestone({ ...(input as object), origin: 'you' }, p.milestones.length, 'you');
      if (!m) return null;
      p.milestones = cleanMilestones([...p.milestones, m], 'you');
      return p;
    }, now);
  }

  removeMilestone(id: string, mid: string, now = new Date()) {
    return this.mutate(id, (p) => {
      p.milestones = cleanMilestones(
        p.milestones.filter((m) => m.id !== mid).map((m) => ({ ...m, dependsOn: m.dependsOn.filter((d) => d !== mid) })),
        'you',
      );
      return p;
    }, now);
  }

  setInspect(id: string, inspect: Partial<Project['inspect']>, now = new Date()) {
    return this.mutate(id, (p) => ({ ...p, inspect: { ...p.inspect, ...inspect } }), now);
  }

  setProposal(id: string, proposal: Proposal | null, now = new Date()) {
    return this.mutate(id, (p) => ({ ...p, proposal }), now);
  }

  applyProposal(id: string, proposalId: string, now = new Date()) {
    return this.mutate(id, (p) => {
      if (!p.proposal || p.proposal.id !== proposalId) return null;
      p.milestones = mergeProposal(p.milestones, p.proposal.milestones);
      p.proposal = null;
      return p;
    }, now);
  }

  remove(id: string): boolean {
    const all = this.list();
    const next = all.filter((p) => p.id !== id);
    if (next.length === all.length) return false;
    this.write(next);
    return true;
  }
}

// --------------------------------------------------------------------------
// Into the day plan: today's scheduled steps become Next items.

export interface ProjectRaw {
  id: string;
  projectId: string;
  space: 'school' | 'personal';
  milestoneId: string;
  title: string;
  context: string;
  dueISO: string | null;
  estMinutes: number;
  why: string;
  url: string | null;
  critical: boolean;
  atRisk: boolean;
  successors: number;
}

export function projectRaws(views: ProjectView[]): ProjectRaw[] {
  const out: ProjectRaw[] = [];
  for (const v of views) {
    if (v.status !== 'active' || !v.today) continue;
    for (const slot of v.today.items) {
      const m = v.milestones.find((x) => x.id === slot.id);
      if (!m) continue;
      const successors = v.milestones.filter((x) => x.dependsOn.includes(m.id)).length;
      const fin = m.plannedFinish ? new Date(`${m.plannedFinish}T23:59:00`) : null;
      const slackWords =
        m.slackDays === null ? '' : m.slackDays <= 0 ? 'No spare days: if this slips, the deadline slips.' : `It can wait ${m.slackDays} day${m.slackDays === 1 ? '' : 's'} without risking the deadline.`;
      out.push({
        id: `project:${v.id}:${m.id}`,
        projectId: v.id,
        space: v.space,
        milestoneId: m.id,
        title: m.title,
        context: v.title,
        dueISO: fin ? fin.toISOString() : null,
        estMinutes: slot.minutes,
        why: [
          slot.minutes < m.estMinutes ? `Today's part: ${hm(slot.minutes)} of ${hm(m.estMinutes)}.` : '',
          slackWords,
          m.owner === 'wait' ? 'Someone else has to act; your part is the nudge.' : '',
        ]
          .filter(Boolean)
          .join(' '),
        url: m.url,
        critical: slot.critical,
        atRisk: m.atRisk,
        successors,
      });
    }
  }
  return out;
}
