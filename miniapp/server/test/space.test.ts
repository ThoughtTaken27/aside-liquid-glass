import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceSpace, spaceOf } from '../src/next.js';
import { TaskStore, taskRaw } from '../src/tasks.js';

describe('school and personal', () => {
  it('school feeds are always school, whatever the item claims', () => {
    expect(spaceOf({ source: 'schoology', space: 'personal' })).toBe('school');
    expect(spaceOf({ source: 'school-mail', space: 'personal' })).toBe('school');
    expect(spaceOf({ source: 'mail', space: 'school' })).toBe('personal');
  });

  it('tasks and projects carry their own space, personal by default', () => {
    expect(spaceOf({ source: 'manual', space: 'school' })).toBe('school');
    expect(spaceOf({ source: 'manual' })).toBe('personal');
    expect(spaceOf({ source: 'project', space: 'school' })).toBe('school');
    expect(sourceSpace('school-mail')).toBe('school');
    expect(sourceSpace('personal-mail')).toBe('personal');
  });

  it('a task is added to a space and can be moved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-space-'));
    const store = new TaskStore(path.join(dir, 'tasks.json'));
    const t = store.add({ title: 'Lab report', space: 'school' });
    if ('error' in t) throw new Error(t.error);
    expect(taskRaw(t).space).toBe('school');
    expect(store.setSpace(t.id, 'personal')?.space).toBe('personal');
    expect(store.list()[0].space).toBe('personal');
    expect(store.add({ title: 'Call the dentist', space: 'bogus' })).toMatchObject({ space: 'personal' });
    expect(store.setSpace('ffffffffff', 'school')).toBeNull();
  });
});
