import { describe, expect, it } from 'vitest';
import { steadySessionRows, groupByDay } from '../src/components/SessionList';
import type { SessionRow } from '../src/types';
const now = new Date(2026, 9, 21, 12).getTime();
const row = (id: string, updatedAt = now, waiting = false) => ({ id, updatedAt, waiting } as SessionRow);
describe('history polling stability', () => {
  it('refreshes data without swapping existing rows when running chats alternate timestamps', () => {
    const rows = [row('b', now), row('a', now - 1000)];
    const result = steadySessionRows(rows, ['a', 'b'], now);
    expect(result.map(r => r.id)).toEqual(['a', 'b']);
    expect(result[0]).toBe(rows[1]);
  });
  it('retains meaningful date grouping when a session changes bands', () => {
    const rows = [row('c', now), row('a', now - 1000), row('b', now - 86400000)];
    const result = steadySessionRows(rows, ['a', 'b', 'c'], now);
    expect(result.map(r => r.id)).toEqual(['a', 'c', 'b']);
    expect(groupByDay(result, now).map(g => g.label)).toEqual(['Today', 'Yesterday']);
  });
  it('keeps the stored oldest-first order and still respects waiting priority', () => {
    expect(steadySessionRows([row('b'), row('a')], ['a', 'b'], now).map(r => r.id)).toEqual(['a', 'b']);
    expect(steadySessionRows([row('waiting', now, true), row('a')], ['a', 'waiting'], now)[0].id).toBe('waiting');
    // Oldest-first input puts waiting last before the final priority pass.
    expect(steadySessionRows([row('a'), row('waiting', now, true)], ['a', 'waiting'], now)[0].id).toBe('waiting');
  });
});
