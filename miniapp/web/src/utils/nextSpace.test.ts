import { describe, expect, it } from 'vitest';
import type { NextItem, NextPlan } from '../types';
import { itemSpace, scopePlan, spaceSummary } from './nextSpace';

const it0 = (id: string, over: Partial<NextItem> = {}): NextItem =>
  ({ id, source: 'schoology', space: 'school', title: id, context: '', dueISO: null, estMinutes: 30, overdue: false, ...over }) as NextItem;

const plan = (over: Partial<NextPlan> = {}): NextPlan =>
  ({
    generatedAt: '', now: null, next: [], later: [], unsure: [], withAside: [], doneToday: [], notices: [], review: [],
    pickUp: null, dayLine: '', queuedMinutes: 0, sources: [], refreshPrompt: null, personalNote: null, projects: [], ...over,
  }) as NextPlan;

describe('scopePlan', () => {
  const p = plan({
    now: it0('s1'),
    next: [it0('p1', { source: 'manual', space: 'personal' }), it0('s2'), it0('s3')],
    later: [it0('s4'), it0('p2', { source: 'mail', space: 'personal' }), it0('s5')],
    review: [it0('g1', { source: 'mail', space: 'personal', trial: true })],
    personalNote: '2 private',
    pickUp: { title: 't', url: 'https://x', kind: 'Docs', lastAt: 0, minutes: 30 } as unknown as NextPlan['pickUp'],
    sources: [
      { id: 'schoology', label: 'Schoology', updatedAt: null, count: 1, ok: true },
      { id: 'personal-mail', label: 'Personal email', updatedAt: null, count: 1, ok: true },
    ],
    projects: [{ id: 'c', space: 'personal', title: 'College', health: 'on-track', line: '', deadlineISO: '', done: 1, total: 2, todayMin: 0 }],
  });

  it('gives each space its own Now and Up next, keeping rank order', () => {
    const s = scopePlan(p, 'school');
    expect(s.now?.id).toBe('s1');
    expect(s.next.map((x) => x.id)).toEqual(['s2', 's3', 's4']);
    expect(s.later.map((x) => x.id)).toEqual(['s5']);
    const q = scopePlan(p, 'personal');
    expect(q.now?.id).toBe('p1');
    expect(q.next.map((x) => x.id)).toEqual(['p2']);
  });

  it('never leaks Gmail, private counts, or personal projects into School', () => {
    const s = scopePlan(p, 'school');
    expect(s.review).toEqual([]);
    expect(s.personalNote).toBeNull();
    expect(s.projects).toEqual([]);
    expect(s.sources.map((x) => x.id)).toEqual(['schoology']);
    const q = scopePlan(p, 'personal');
    expect(q.review?.map((x) => x.id)).toEqual(['g1']);
    expect(q.personalNote).toBe('2 private');
    expect(q.pickUp).toBeNull();
    expect(q.sources.map((x) => x.id)).toEqual(['personal-mail']);
  });

  it('files old items without a space by their source', () => {
    expect(itemSpace({ source: 'school-mail' })).toBe('school');
    expect(itemSpace({ source: 'manual' })).toBe('personal');
  });

  it('does not claim an overdue item ranks first when another task is the next move', () => {
    const late = it0('late', { overdue: true, lateConfirmed: true, dueISO: new Date(Date.now() - 86_400_000).toISOString() });
    const p = plan({ now: it0('top'), next: [late] });
    expect(scopePlan(p, 'school').dayLine).toContain('One thing is late. Check its status.');
  });

  it('flags a real deadline in the other space, not a planned project step', () => {
    const today = new Date();
    const late = plan({ now: it0('p', { source: 'manual', space: 'personal', dueISO: today.toISOString(), overdue: true }) });
    expect(spaceSummary(late, 'personal', today).urgent).toBe(true);
    expect(spaceSummary(late, 'school', today).urgent).toBe(false);
    const step = plan({ now: it0('j', { source: 'project', space: 'personal', dueISO: today.toISOString() }) });
    expect(spaceSummary(step, 'personal', today).urgent).toBe(false);
  });
});
