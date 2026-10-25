/** Volatile context only. Never persist evidence/history in browser storage. */
import type { NextItem, NextPlan } from '../types';
const CACHE = 'next.plan.v1';
let floor = 0;
let epoch = 0;
let channel: BroadcastChannel | null = null;
const listeners = new Set<() => void>();
const signal = (revision: number) => {
  if (!Number.isSafeInteger(revision) || revision < 0) return;
  floor = Math.max(floor, revision); epoch += 1;
  try { localStorage.removeItem(CACHE); } catch { /* unavailable storage is not a reason to retain context */ }
  listeners.forEach(fn => fn());
};
function connect() {
  if (channel || typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return;
  channel = new window.BroadcastChannel('next-context-revision');
  channel.onmessage = event => { if (typeof event.data === 'number') signal(event.data); };
}
export const contextEpoch = () => epoch;
export const minimumContextRevision = () => floor;
export function contextChanged(revision: number) { connect(); signal(revision); channel?.postMessage(revision); }
export function onContextChanged(fn: () => void): () => void { connect(); listeners.add(fn); return () => { listeners.delete(fn); }; }

/** Restore non-context ordering too, so an offline plan is not a hidden derivative. */
export function contextFreePlan(p: NextPlan): NextPlan {
  const clean = (it: NextItem): NextItem => { const x = { ...it, trail: null }; delete x.evidence; return x; };
  const q = { ...p, now: p.now ? clean(p.now) : null, next: p.next.map(clean), later: p.later.map(clean), unsure: p.unsure.map(clean), withAside: p.withAside.map(clean), doneToday: p.doneToday.map(clean), ...(p.review ? { review: p.review.map(clean) } : {}), pickUp: null };
  delete q.context;
  if (p.context || [p.now, ...p.next, ...p.later].some(it => it?.evidence)) {
    const ranked = [q.now, ...q.next, ...q.later].filter((it): it is NextItem => Boolean(it)).sort((a, b) => b.score - a.score || (a.dueISO ? Date.parse(a.dueISO) : Infinity) - (b.dueISO ? Date.parse(b.dueISO) : Infinity) || a.title.localeCompare(b.title));
    q.now = ranked[0] ?? null; q.next = ranked.slice(1, 1 + p.next.length); q.later = ranked.slice(1 + p.next.length);
    q.queuedMinutes = [q.now, ...q.next].reduce((n, it) => n + (it?.estMinutes ?? 0), 0);
  }
  return q;
}
export function acceptContextPlan(p: NextPlan): NextPlan {
  const revision = p.context?.revision;
  const evidence = [p.now, ...p.next, ...p.later, ...p.unsure, ...p.withAside, ...p.doneToday, ...(p.review ?? [])].filter((x): x is NextItem => Boolean(x)).map(x => x.evidence?.revision).filter((x): x is number => x !== undefined);
  return (revision !== undefined && revision < floor) || evidence.some(r => r < floor) ? contextFreePlan(p) : p;
}
export function contextFreshness(record: { observedAt: string | null; expiresAt: string | null }): 'fresh' | 'stale' | 'unknown' {
  if (!record.observedAt || !record.expiresAt || !Number.isFinite(Date.parse(record.observedAt)) || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.observedAt) > Date.now()) return 'unknown';
  return Date.parse(record.expiresAt) > Date.now() ? 'fresh' : 'stale';
}
