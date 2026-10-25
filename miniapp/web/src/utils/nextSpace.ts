/**
 * School and Personal: one rule for the phone and the Mac.
 *
 * The server ranks everything once and tags each thing with its space.
 * Here the plan is cut to one space and re-sliced, so each space gets its
 * own Now, its own Up next, and nothing from the other one leaks in.
 */
import { useCallback, useState } from 'react';
import type { NextItem, NextPlan, NextSpace } from '../types';

export const SPACES: Array<{ id: NextSpace; label: string }> = [
  { id: 'school', label: 'School' },
  { id: 'personal', label: 'Personal' },
];

export const spaceLabel = (s: NextSpace): string => (s === 'school' ? 'School' : 'Personal');
export const otherSpace = (s: NextSpace): NextSpace => (s === 'school' ? 'personal' : 'school');

/** Same size as the server's Up next. */
const NEXT_COUNT = 3;

/** Older plans had no space: school feeds are school, everything else is personal. */
export function itemSpace(it: { space?: NextSpace; source: NextItem['source'] }): NextSpace {
  if (it.space === 'school' || it.space === 'personal') return it.space;
  return it.source === 'schoology' || it.source === 'school-mail' ? 'school' : 'personal';
}

function sourceSpace(s: { id: string; space?: NextSpace }): NextSpace {
  return s.space ?? (s.id === 'schoology' || s.id === 'school-mail' ? 'school' : 'personal');
}

export function scopePlan(plan: NextPlan, space: NextSpace): NextPlan {
  const mine = <T extends { space?: NextSpace; source: NextItem['source'] }>(xs: T[]): T[] => xs.filter((x) => itemSpace(x) === space);
  const ranked = mine([plan.now, ...plan.next, ...plan.later].filter(Boolean) as NextItem[]);
  const now = ranked[0] ?? null;
  const next = ranked.slice(1, 1 + NEXT_COUNT);
  const later = ranked.slice(1 + NEXT_COUNT);
  const doneToday = mine(plan.doneToday);
  const personal = space === 'personal';
  return {
    ...plan,
    now,
    next,
    later,
    dayLine: spaceDayLine(ranked, doneToday.length, new Date()),
    unsure: mine(plan.unsure),
    withAside: mine(plan.withAside),
    doneToday: mine(plan.doneToday),
    notices: mine(plan.notices),
    review: personal ? mine(plan.review ?? []) : [],
    personalNote: personal ? plan.personalNote ?? null : null,
    // Picking up a browser session is study work; it lives with School.
    pickUp: personal ? null : plan.pickUp,
    projects: (plan.projects ?? []).filter((p) => (p.space ?? 'personal') === space),
    sources: plan.sources.filter((s) => sourceSpace(s) === space),
    queuedMinutes: [now, ...next].reduce((sum, it) => sum + (it?.estMinutes ?? 0), 0),
  };
}

export interface SpaceSummary {
  /** Now + Up next + anything else due today (what Today shows). */
  count: number;
  /** A real deadline today or already past (never a planned project step). */
  urgent: boolean;
}

/** Same words as the server's day line, recomputed for one space.
 * ponytail: mirrors server/src/next.ts dayLine; dedupe into a shared
 * package when server and web share code. */
export function spaceDayLine(open: NextItem[], doneCount: number, now = new Date()): string {
  const hi = now.getHours() < 5 ? 'Late night.' : now.getHours() < 12 ? 'Morning.' : now.getHours() < 17 ? 'Afternoon.' : now.getHours() < 22 ? 'Evening.' : 'Late night.';
  if (!open.length) return doneCount ? `${hi} All clear, and ${doneCount} done today.` : `${hi} Nothing needs you right now.`;
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const today = day(now);
  const word = (n: number) => (['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'][n] ?? String(n));
  const late = open.filter((it) => it.overdue && it.lateConfirmed);
  const unconfirmed = open.filter((it) => it.overdue && !it.lateConfirmed);
  const dueToday = open.filter((it) => !it.overdue && it.dueISO && day(new Date(it.dueISO)) === today);
  if (late.length) return `${hi} ${late.length === 1 ? 'One thing is late' : `${word(late.length)} things are late`}. Check ${late.length === 1 ? 'its' : 'their'} status.`;
  if (unconfirmed.length) return `${hi} ${unconfirmed.length === 1 ? 'One thing passed its due date' : `${word(unconfirmed.length)} things passed their due dates`} without a check since.`;
  const minutes = dueToday.reduce((s, it) => s + (it.estMinutes ?? 0), 0);
  // Same wording as the server's hoursText.
  const hoursText = (min: number) => {
    if (min < 50) return `about ${Math.max(5, Math.round(min / 5) * 5)} minutes`;
    const h = Math.round((min / 60) * 2) / 2;
    return h === 1 ? 'about an hour' : `about ${h} hours`;
  };
  if (dueToday.length === 1) return `${hi} One thing is due today${minutes ? `, ${hoursText(minutes)} of work` : ''}.`;
  if (dueToday.length > 1) return `${hi} ${word(dueToday.length)} things are due today${minutes ? `, ${hoursText(minutes)} in all` : ''}.`;
  return `${hi} Nothing is due today.`;
}

export function spaceSummary(plan: NextPlan, space: NextSpace, now = new Date()): SpaceSummary {
  const p = scopePlan(plan, space);
  const today = now.toDateString();
  const deadline = (it: NextItem) => it.source !== 'project' && !!it.dueISO && (it.overdue || new Date(it.dueISO).toDateString() === today);
  const open = [p.now, ...p.next, ...p.later].filter(Boolean) as NextItem[];
  const dueToday = p.later.filter((it) => it.dueISO && new Date(it.dueISO).toDateString() === today);
  return {
    // Same number as Today in the list: Gmail on trial is not counted until you keep it.
    count: (p.now ? 1 : 0) + p.next.length + dueToday.length,
    urgent: open.some(deadline),
  };
}

const KEY = 'next.space';

function readSpace(): NextSpace {
  try {
    return localStorage.getItem(KEY) === 'personal' ? 'personal' : 'school';
  } catch {
    return 'school';
  }
}

/** The chosen space, remembered on this device. */
export function useSpace(): [NextSpace, (s: NextSpace) => void] {
  const [space, set] = useState<NextSpace>(readSpace);
  const choose = useCallback((s: NextSpace) => {
    set(s);
    try {
      localStorage.setItem(KEY, s);
    } catch {
      /* private mode: still works for this visit */
    }
  }, []);
  return [space, choose];
}
