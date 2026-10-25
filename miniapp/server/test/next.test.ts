import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NextStore,
  adaptFeed,
  adaptSchoology,
  buildPlan,
  parseAction,
  tidyCourse,
  urgencyFor,
  type RawItem,
} from '../src/next.js';

const NOW = new Date('2026-09-24T19:30:00-05:00');

function raw(over: Partial<RawItem> & { id: string }): RawItem {
  return {
    source: 'schoology',
    title: over.id,
    context: '',
    dueISO: null,
    estMinutes: 30,
    lane: 'you',
    why: '',
    url: null,
    steps: [],
    confidence: 1,
    impact: 10,
    lateRisk: 0,
    dependency: 0,
    resolved: false,
    acceptsLate: true,
    ...over,
  };
}

describe('urgency', () => {
  it('follows the planner table', () => {
    expect(urgencyFor('2026-09-24T23:59:00-05:00', 5, NOW)).toBe(28);
    expect(urgencyFor('2026-09-26T08:00:00-05:00', 5, NOW)).toBe(18);
    expect(urgencyFor('2026-09-20T08:00:00-05:00', 5, NOW)).toBe(30);
    expect(urgencyFor(null, 5, NOW)).toBe(1);
  });

  it('applies start-by pressure to long tasks', () => {
    // Due in 120h. A 4h task starts 10h out (not yet); a 50h task needed to start 125h out.
    expect(urgencyFor('2026-09-29T19:30:00-05:00', 240, NOW)).toBe(9);
    expect(urgencyFor('2026-09-29T19:30:00-05:00', 3000, NOW)).toBe(22);
  });
});

describe('schoology adapter', () => {
  const notes = {
    '111': {
      title: 'Lab pre-questions',
      course: 'Physics F 100001',
      courseId: 'p',
      dueISO: '2026-09-24T23:59:00-05:00',
      categoryWeight: 30,
      maxPoints: 100,
      type: 'assessment',
      attemptState: 'Start Attempt button; no attempt started; one attempt only',
      estMinutes: 45,
    },
    '222': { title: 'Old', course: 'X', dueISO: null, attemptState: 'graded' },
    '333': {
      title: 'Done',
      course: 'Calculus Hnrs F 1',
      courseId: 'c',
      dueISO: '2026-09-24T14:59:00-05:00',
      attemptState: 'graded',
    },
    '444': {
      title: 'Excluded course item',
      courseId: 'econ',
      dueISO: '2026-09-25T10:00:00-05:00',
    },
    '555': {
      title: 'Stale',
      courseId: 'c',
      dueISO: '2026-09-01T10:00:00-05:00',
    },
  };
  const items = adaptSchoology(notes, new Set(['econ']), NOW, 'https://school.example.com');

  it('keeps dated, in-scope, recent items only', () => {
    expect(items.map((i) => i.id).sort()).toEqual(['schoology:111', 'schoology:333']);
  });

  it('marks graded work resolved and reads one-shot risk', () => {
    const lab = items.find((i) => i.id === 'schoology:111')!;
    const calc = items.find((i) => i.id === 'schoology:333')!;
    expect(calc.resolved).toBe(true);
    expect(lab.resolved).toBe(false);
    expect(lab.lateRisk).toBe(7);
    expect(lab.url).toBe('https://school.example.com/assignment/111');
    expect(lab.context).toBe('Physics');
  });

  it('tidies course names', () => {
    expect(tidyCourse('Calculus Hnrs F 100002')).toBe('Calculus Honors');
    expect(tidyCourse('Design III F 100003')).toBe('Design III');
  });
});

describe('feed adapter', () => {
  it('drops malformed entries and non-https urls', () => {
    const feed = adaptFeed({
      label: 'Inbox',
      items: [
        {
          id: 'gmail:abc',
          title: 'Reply to counselor',
          url: 'javascript:alert(1)',
          confidence: 0.9,
          lane: 'aside',
        },
        { id: 'bad id with spaces', title: 'x' },
        { title: 'no id' },
        {
          id: 'gmail:def',
          title: 'x'.repeat(500),
          url: 'https://mail.google.com/x',
          lane: 'rm -rf',
        },
      ],
    });
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0].url).toBeNull();
    expect(feed.items[1].title.length).toBeLessThanOrEqual(140);
    expect(feed.items[1].lane).toBe('you');
  });
});

describe('plan', () => {
  it('puts the highest score in Now, then up to three next', () => {
    const plan = buildPlan(
      [
        raw({ id: 'a', impact: 5, dueISO: '2026-10-05T08:00:00-05:00' }),
        raw({ id: 'b', impact: 36, dueISO: '2026-09-24T23:59:00-05:00' }),
        raw({ id: 'c', impact: 14 }),
        raw({ id: 'd', impact: 3 }),
        raw({ id: 'e', impact: 1 }),
        raw({ id: 'm', impact: 40, confidence: 0.4 }),
      ],
      { items: {} },
      [],
      NOW,
    );
    expect(plan.now?.id).toBe('b');
    expect(plan.next.map((i) => i.id)).toEqual(['c', 'a', 'd']);
    expect(plan.later.map((i) => i.id)).toEqual(['e']);
    expect(plan.unsure.map((i) => i.id)).toEqual(['m']);
  });

  it('respects user marks and source closure', () => {
    const plan = buildPlan(
      [
        raw({ id: 'a', impact: 40 }),
        raw({
          id: 'b',
          impact: 30,
          resolved: true,
          dueISO: '2026-09-24T15:00:00-05:00',
        }),
        raw({ id: 'c', impact: 20 }),
        raw({ id: 'd', impact: 10 }),
        raw({ id: 'm', impact: 11, confidence: 0.3 }),
      ],
      {
        items: {
          a: {
            status: 'snoozed',
            until: '2026-09-25T08:00:00-05:00',
            at: NOW.toISOString(),
          },
          c: {
            status: 'handed-off',
            sessionId: 'ses_123456',
            at: NOW.toISOString(),
          },
          m: { status: 'kept', at: NOW.toISOString() },
        },
      },
      [],
      NOW,
    );
    expect(plan.now?.id).toBe('m');
    expect(plan.withAside.map((i) => i.sessionId)).toEqual(['ses_123456']);
    expect(plan.doneToday.map((i) => [i.id, i.closedBy])).toEqual([['b', 'source']]);
  });

  it('never offers an action helper for graded schoolwork', () => {
    const plan = buildPlan([raw({ id: 'a', url: 'https://school.example.com/assignment/1' })], { items: {} }, [], NOW);
    expect(plan.now?.brief.mode).toBe('none');
    expect(plan.now?.brief.wont.join(' ')).toMatch(/graded work/);
  });

  it('treats anything from mail as tainted, whatever the feed claims', () => {
    const feed = adaptFeed({
      items: [
        { id: 'gmail0:t1', source: 'mail', title: 'Reply to coach', taint: null, kind: 'reply', confidence: 0.9 },
        { id: 'x:1', title: 'No source given', confidence: 0.9 },
      ],
    });
    expect(feed.items.map((i) => i.taint)).toEqual(['email', 'email']);
    const plan = buildPlan(feed.items, { items: {} }, [], NOW);
    const all = [plan.now, ...plan.next, ...plan.later].filter(Boolean);
    expect(all.every((i) => i!.brief.mode !== 'agent')).toBe(true);
  });

  it('parks flagged items in unsure with no offer', () => {
    const plan = buildPlan(
      [raw({ id: 'f', source: 'mail', taint: 'email', flag: 'suspicious', confidence: 1, impact: 50 })],
      { items: {} },
      [],
      NOW,
    );
    expect(plan.now).toBeNull();
    expect(plan.unsure[0].brief.mode).toBe('none');
  });

  it('links a task to the doc it is being worked in, and gives it momentum', () => {
    const trail = [
      { key: 'gdoc:x', kind: 'Slides' as const, title: 'Sonnet Presentation', url: 'https://docs.google.com/presentation/d/x/edit', lastAt: NOW.getTime() - 3_600_000, minutes: 40 },
    ];
    const plan = buildPlan(
      [raw({ id: 's', title: 'Sonnet Slide Deck and Presentation', impact: 10 }), raw({ id: 'o', title: 'Other thing', impact: 11 })],
      { items: {} },
      [],
      NOW,
      trail,
    );
    expect(plan.now?.id).toBe('s');
    expect(plan.now?.trail?.minutes).toBe(40);
    // The hero's own doc is not repeated as "pick up".
    expect(plan.pickUp).toBeNull();
  });

  it('says something true about the day', () => {
    const tonight = new Date(NOW.getTime() + 3 * 3_600_000).toISOString();
    const one = buildPlan([raw({ id: 'a', dueISO: tonight, estMinutes: 30 })], { items: {} }, [], NOW);
    expect(one.dayLine).toBe('Evening. One thing is due today, about 30 minutes of work.');
    const none = buildPlan([], { items: {} }, [], NOW);
    expect(none.dayLine).toBe('Evening. Nothing needs you right now.');
    // Past due, but the source never looked again: not "late", a check.
    const unchecked = buildPlan([raw({ id: 'l', dueISO: '2026-09-23T10:00:00-05:00' })], { items: {} }, [], NOW);
    expect(unchecked.now?.lateConfirmed).toBe(false);
    expect(unchecked.dayLine).toBe('Evening. One thing passed its due date without a check since. Make sure it went in.');
    const late = buildPlan(
      [raw({ id: 'l', dueISO: '2026-09-23T10:00:00-05:00', checkedAt: '2026-09-24T08:00:00-05:00' })],
      { items: {} },
      [],
      NOW,
    );
    expect(late.now?.lateConfirmed).toBe(true);
    expect(late.dayLine).toBe('Evening. One thing is late. Check its status.');
    // A tiny time-bound task drops off once it is well past.
    const book = buildPlan([raw({ id: 'b', dueISO: '2026-09-23T10:00:00-05:00', estMinutes: 5 })], { items: {} }, [], NOW);
    expect(book.now).toBeNull();
    const inClass = buildPlan([raw({ id: 'c', title: 'Lit Circle Book in Class', dueISO: '2026-09-24T12:00:00-05:00', estMinutes: null })], { items: {} }, [], NOW);
    expect(inClass.now).toBeNull();
  });
});

describe('store', () => {
  it('round-trips actions through an atomic state file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-'));
    const root = path.join(dir, 'root');
    fs.mkdirSync(path.join(root, 'next/feeds'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'next/feeds/inbox.json'),
      JSON.stringify({
        label: 'Inbox',
        items: [{ id: 'gmail:1', title: 'Reply', confidence: 0.9 }],
      }),
    );
    fs.writeFileSync(path.join(root, 'next/config.json'), JSON.stringify({ personalMail: { enabled: true, account: 'owner@example.com' } }));
    const store = new NextStore({
      asideRoot: root,
      stateDir: path.join(dir, 'state'),
    });
    expect(store.plan(NOW).now?.id).toBe('gmail:1');
    store.apply('gmail:1', { type: 'done' }, NOW);
    expect(store.plan(NOW).now).toBeNull();
    expect(store.plan(NOW).doneToday[0].closedBy).toBe('you');
    store.apply('gmail:1', { type: 'reopen' }, NOW);
    expect(store.plan(NOW).now?.id).toBe('gmail:1');
    expect(store.plan(NOW).sources[0]).toMatchObject({
      id: 'inbox',
      label: 'Inbox',
      count: 1,
      ok: true,
    });
  });

  it('parses only known actions', () => {
    expect(parseAction({ type: 'done' })).toEqual({ type: 'done' });
    expect(parseAction({ type: 'snooze', until: 'soon' })).toBeNull();
    expect(parseAction({ type: 'handoff', sessionId: '../../etc' })).toBeNull();
    expect(parseAction({ type: 'rm' })).toBeNull();
  });
});
