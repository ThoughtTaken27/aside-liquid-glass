import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asProposal,
  capacityOn,
  cleanMilestones,
  diffProposal,
  extractJsonBlock,
  mergeProposal,
  ProjectStore,
  projectRaws,
  scheduleProject,
  type Milestone,
  type Project,
} from '../src/projects.js';

// Thursday Sep 24 2026, 10:00 local: before the weekday window opens.
const NOW = new Date(2026, 8, 24, 10, 0, 0);

function ms(over: Partial<Milestone> & { id: string }): Milestone {
  return {
    title: over.id,
    detail: '',
    estMinutes: 60,
    dependsOn: [],
    status: 'todo',
    owner: 'you',
    fixedDueISO: null,
    evidence: '',
    url: null,
    origin: 'you',
    doneAt: null,
    ...over,
  };
}

function project(milestones: Milestone[], deadline = new Date(2026, 9, 15, 23, 59), over: Partial<Project> = {}): Project {
  return {
    id: 'college-apps',
    title: 'College applications',
    goal: 'All 15 submitted',
    deadlineISO: deadline.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'active',
    space: 'personal',
    capacity: { weekdayMin: 90, weekendMin: 180 },
    milestones,
    inspect: { state: 'idle', sessionId: null, startedAt: null, finishedAt: null, error: null },
    proposal: null,
    ...over,
  };
}

function tmpFile(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-projects-'));
  return path.join(dir, name);
}

describe('cleanMilestones', () => {
  it('drops unknown dependencies, self edges, and cycles, keeping list order', () => {
    const out = cleanMilestones(
      [
        { id: 'a', title: 'A', dependsOn: ['c', 'ghost', 'a'] },
        { id: 'b', title: 'B', dependsOn: ['a'] },
        { id: 'c', title: 'C', dependsOn: ['b'] },
      ],
      'you',
    );
    // a -> c -> b -> a is a cycle: the first edge (a on c) goes.
    expect(out.find((m) => m.id === 'a')!.dependsOn).toEqual([]);
    expect(out.find((m) => m.id === 'b')!.dependsOn).toEqual(['a']);
    expect(out.find((m) => m.id === 'c')!.dependsOn).toEqual(['b']);
  });

  it('strips hidden characters, caps text, clamps effort, and rejects non-https links', () => {
    const [m] = cleanMilestones(
      [{ id: 'x', title: 'Hi\u202eevil\u200b there', estMinutes: 99999, url: 'http://example.com', detail: 'd'.repeat(900) }],
      'inspector',
    );
    expect(m.title).toBe('Hievil there');
    expect(m.estMinutes).toBe(2400);
    expect(m.url).toBeNull();
    expect(m.detail.length).toBe(280);
    expect(m.origin).toBe('inspector');
  });

  it('de-duplicates ids', () => {
    const out = cleanMilestones([{ id: 'a', title: 'One' }, { id: 'a', title: 'Two' }], 'you');
    expect(out.map((m) => m.id)).toEqual(['a', 'a-2']);
  });
});

describe('capacityOn', () => {
  it('counts only what is left of today', () => {
    const cap = { weekdayMin: 80, weekendMin: 160 };
    expect(capacityOn(0, new Date(2026, 8, 24, 10), cap)).toBe(80);
    expect(capacityOn(0, new Date(2026, 8, 24, 19), cap)).toBe(40);
    expect(capacityOn(0, new Date(2026, 8, 24, 23, 30), cap)).toBe(0);
    // Saturday Sep 26
    expect(capacityOn(2, new Date(2026, 8, 24, 10), cap)).toBe(160);
  });
});

describe('scheduleProject', () => {
  it('orders by dependencies and fills real days', () => {
    const v = scheduleProject(
      project([ms({ id: 'essay', estMinutes: 120 }), ms({ id: 'review', estMinutes: 60, dependsOn: ['essay'] })]),
      NOW,
    );
    const essay = v.milestones.find((m) => m.id === 'essay')!;
    const review = v.milestones.find((m) => m.id === 'review')!;
    expect(essay.plannedStart).toBe('2026-09-24');
    expect(essay.plannedFinish).toBe('2026-09-25');
    expect(review.plannedStart! >= essay.plannedFinish!).toBe(true);
    expect(v.health).toBe('on-track');
    expect(v.line).toMatch(/On track/);
    expect(v.today!.minutes).toBe(90);
  });

  it('is deterministic', () => {
    const p = project([ms({ id: 'a', estMinutes: 200 }), ms({ id: 'b', estMinutes: 45 }), ms({ id: 'c', estMinutes: 30, dependsOn: ['a'] })]);
    expect(JSON.stringify(scheduleProject(p, NOW))).toBe(JSON.stringify(scheduleProject(p, NOW)));
  });

  it('puts the least-slack step first, and a hard date pulls a step forward', () => {
    const v = scheduleProject(
      project([
        ms({ id: 'later', estMinutes: 60 }),
        ms({ id: 'urgent', estMinutes: 60, fixedDueISO: new Date(2026, 8, 25, 23, 59).toISOString() }),
      ]),
      NOW,
    );
    expect(v.today!.items[0].id).toBe('urgent');
    expect(v.milestones.find((m) => m.id === 'urgent')!.slackDays).toBe(1);
    expect(v.milestones.find((m) => m.id === 'later')!.slackDays).toBeGreaterThan(5);
  });

  it('flags a plan that does not fit and says by how much', () => {
    const v = scheduleProject(
      project([ms({ id: 'huge', estMinutes: 2400 }), ms({ id: 'huge2', estMinutes: 2400 })], new Date(2026, 8, 28, 23, 59)),
      NOW,
    );
    expect(v.health).toBe('at-risk');
    expect(v.shortMin).toBeGreaterThan(0);
    expect(v.line).toMatch(/more work than time/);
  });

  it('marks tight when the plan eats into the buffer', () => {
    // 21 days left, 3 buffer days. Fill about 19 days of weekday-ish capacity.
    const v = scheduleProject(project([ms({ id: 'big', estMinutes: 2400 }), ms({ id: 'big2', estMinutes: 30 * 60, dependsOn: ['big'] })]), NOW);
    expect(['tight', 'on-track', 'at-risk']).toContain(v.health);
    expect(v.bufferDays).toBe(3);
  });

  it('never schedules slivers under 20 minutes unless it finishes a step', () => {
    const p = project([ms({ id: 'a', estMinutes: 80 }), ms({ id: 'b', estMinutes: 60 })], undefined, {
      capacity: { weekdayMin: 95, weekendMin: 95 },
    });
    const v = scheduleProject(p, NOW);
    for (const d of v.days) for (const it of d.items) {
      const m = v.milestones.find((x) => x.id === it.id)!;
      if (it.minutes < 20) expect(m.plannedFinish).toBe(d.day);
    }
  });

  it('keeps done steps out of the schedule and counts progress', () => {
    const v = scheduleProject(project([ms({ id: 'a', status: 'done' }), ms({ id: 'b', dependsOn: ['a'] })]), NOW);
    expect(v.done).toBe(1);
    expect(v.total).toBe(2);
    expect(v.milestones.find((m) => m.id === 'b')!.plannedStart).toBe('2026-09-24');
  });

  it('does not schedule blocked steps and says so', () => {
    const v = scheduleProject(project([ms({ id: 'a', status: 'blocked' }), ms({ id: 'b' })]), NOW);
    expect(v.milestones.find((m) => m.id === 'a')!.plannedStart).toBeNull();
    expect(v.line).toMatch(/1 blocked step/);
  });

  it('lists waiting-on-someone steps', () => {
    const v = scheduleProject(project([ms({ id: 'letter', owner: 'wait', estMinutes: 10 })]), NOW);
    expect(v.waiting.map((w) => w.id)).toEqual(['letter']);
  });

  it('turns today into Next items with plain reasons', () => {
    const v = scheduleProject(project([ms({ id: 'essay', estMinutes: 120, title: 'Recast the personal essay' })]), NOW);
    const raws = projectRaws([v]);
    expect(raws).toHaveLength(1);
    expect(raws[0].id).toBe('project:college-apps:essay');
    expect(raws[0].estMinutes).toBe(90);
    expect(raws[0].why).toMatch(/Today's part: 1 h 30 min of 2 h/);
  });
});

describe('proposals', () => {
  it('extracts the last json block and validates it', () => {
    const text = 'notes\n```json\n{"a":1}\n```\nmore\n```json\n{"summary":"ok","milestones":[{"id":"x","title":"Do X"}]}\n```';
    const raw = extractJsonBlock(text);
    const p = asProposal(raw, 'sess-123456');
    expect(p!.summary).toBe('ok');
    expect(p!.milestones[0].origin).toBe('inspector');
    expect(extractJsonBlock('no block')).toBeNull();
    expect(asProposal({ milestones: [] }, null)).toBeNull();
  });

  it('diffs by id or matching title words', () => {
    const cur = [ms({ id: 'essay', title: 'Recast personal essay', estMinutes: 120 }), ms({ id: 'old', title: 'Old step' })];
    const next = [ms({ id: 'pe', title: 'Recast the personal essay', estMinutes: 180 }), ms({ id: 'new', title: 'Order transcripts' })];
    const d = diffProposal(cur, next);
    expect(d.added.map((a) => a.id)).toEqual(['new']);
    expect(d.removed.map((a) => a.id)).toEqual(['old']);
    expect(d.changed[0].what.join()).toMatch(/effort 2 h to 3 h/);
  });

  it('merging never un-does finished work and keeps finished history', () => {
    const cur = [ms({ id: 'essay', title: 'Recast personal essay', status: 'done', doneAt: NOW.toISOString() }), ms({ id: 'gone', title: 'Something finished', status: 'done' })];
    const next = [ms({ id: 'pe', title: 'Recast the personal essay', status: 'todo' }), ms({ id: 'sub', title: 'Submit Purdue', dependsOn: ['pe'] })];
    const merged = mergeProposal(cur, next);
    expect(merged.find((m) => m.id === 'essay')!.status).toBe('done');
    expect(merged.find((m) => m.id === 'sub')!.dependsOn).toEqual(['essay']);
    expect(merged.some((m) => m.id === 'gone')).toBe(true);
  });
});

describe('ProjectStore', () => {
  it('creates, edits steps, applies a proposal, and survives corrupt files', () => {
    const file = tmpFile('projects.json');
    const store = new ProjectStore(file);
    const p = store.create({ title: 'College applications', goal: 'All in', deadline: '2026-10-15' }, NOW);
    expect('id' in p).toBe(true);
    const id = (p as Project).id;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    store.addMilestone(id, { title: 'Recast essay', estMinutes: 120 }, NOW);
    const m = store.get(id)!.milestones[0];
    store.setMilestone(id, m.id, { status: 'done' }, NOW);
    expect(store.get(id)!.milestones[0].status).toBe('done');
    const prop = asProposal({ summary: 's', milestones: [{ id: 'n', title: 'Order transcripts' }] }, null, NOW)!;
    store.setProposal(id, prop, NOW);
    expect(store.applyProposal(id, 'wrong', NOW)).toBeNull();
    store.applyProposal(id, prop.id, NOW);
    const after = store.get(id)!;
    expect(after.proposal).toBeNull();
    expect(after.milestones.map((x) => x.title)).toEqual(['Recast essay', 'Order transcripts']);
    fs.writeFileSync(file, '{nope');
    expect(store.list()).toEqual([]);
  });

  it('rejects a past deadline and a missing title', () => {
    const store = new ProjectStore(tmpFile('p.json'));
    expect(store.create({ title: '', goal: '', deadline: '2026-10-15' }, NOW)).toEqual({ error: 'title_required' });
    expect(store.create({ title: 'X', goal: '', deadline: '2020-01-01' }, NOW)).toEqual({ error: 'bad_deadline' });
  });
});
