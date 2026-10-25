/**
 * Quick add: tasks he types himself. His own words, so they are trusted
 * like a Schoology item, but still cleaned and capped like everything else.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextSpace, RawItem } from './next.js';
import { clean, endOfDayISO, type ProjectRaw } from './projects.js';

export interface ManualTask {
  id: string;
  title: string;
  dueISO: string | null;
  estMinutes: number | null;
  createdAt: string;
  space: NextSpace;
}

const MAX_TASKS = 200;

export class TaskStore {
  constructor(private readonly file: string) {}

  list(): ManualTask[] {
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { tasks?: unknown[] };
      return (doc.tasks ?? [])
        .map((t) => {
          const v = (t ?? {}) as Record<string, unknown>;
          const id = typeof v.id === 'string' && /^[a-f0-9]{8,16}$/.test(v.id) ? v.id : null;
          const title = clean(v.title, 140);
          if (!id || !title) return null;
          const est = Number(v.estMinutes);
          return {
            id,
            title,
            dueISO: endOfDayISO(v.dueISO),
            estMinutes: Number.isFinite(est) && est > 0 ? Math.min(600, Math.round(est)) : null,
            createdAt: endOfDayISO(v.createdAt) ?? new Date(0).toISOString(),
            space: v.space === 'school' ? 'school' : 'personal',
          };
        })
        .filter((t): t is ManualTask => t !== null);
    } catch {
      return [];
    }
  }

  add(input: { title: unknown; due?: unknown; estMinutes?: unknown; space?: unknown }, now = new Date()): ManualTask | { error: string } {
    const title = clean(input.title, 140);
    if (!title) return { error: 'title_required' };
    const est = Number(input.estMinutes);
    const task: ManualTask = {
      id: crypto.randomBytes(5).toString('hex'),
      title,
      dueISO: endOfDayISO(input.due ?? null),
      estMinutes: Number.isFinite(est) && est > 0 ? Math.min(600, Math.round(est)) : null,
      createdAt: now.toISOString(),
      space: input.space === 'school' ? 'school' : 'personal',
    };
    // Oldest drop off first; done/dismissed marks live in the user state.
    this.write([...this.list(), task].slice(-MAX_TASKS));
    return task;
  }

  /** Move a task you added between School and Personal. */
  setSpace(id: string, space: NextSpace): ManualTask | null {
    const all = this.list();
    const t = all.find((x) => x.id === id);
    if (!t) return null;
    t.space = space;
    this.write(all);
    return t;
  }

  private write(all: ManualTask[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, tasks: all }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

export function taskRaw(t: ManualTask): RawItem {
  return {
    id: `manual:${t.id}`,
    source: 'manual',
    space: t.space,
    title: t.title,
    context: 'Added by you',
    dueISO: t.dueISO,
    estMinutes: t.estMinutes,
    lane: 'you',
    why: '',
    url: null,
    steps: [],
    confidence: 1,
    impact: 24,
    lateRisk: 4,
    dependency: 0,
    resolved: false,
    acceptsLate: true,
    kind: 'errand',
    atISO: t.createdAt,
  };
}

export function projectRaw(r: ProjectRaw): RawItem {
  return {
    id: r.id,
    source: 'project',
    space: r.space,
    title: r.title,
    context: r.context,
    dueISO: r.dueISO,
    estMinutes: r.estMinutes,
    lane: 'you',
    why: r.why,
    url: r.url,
    steps: [],
    confidence: 1,
    // A critical-path step outranks a comfortable one; at-risk adds more.
    impact: r.critical ? 32 : 24,
    lateRisk: r.atRisk ? 12 : r.critical ? 8 : 3,
    dependency: Math.min(8, r.successors * 2),
    resolved: false,
    acceptsLate: true,
    kind: 'project',
  };
}
