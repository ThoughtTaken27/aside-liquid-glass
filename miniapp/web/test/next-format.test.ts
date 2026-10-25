import { describe, expect, it } from 'vitest';
import { formatDue, formatDueShort, formatMinutes, metaSentence } from '../src/utils/nextFormat';

// Wednesday, 7:00 AM local.
const now = new Date(2026, 8, 23, 7, 0, 0);
const at = (days: number, h: number, m = 0) => new Date(2026, 8, 23 + days, h, m).toISOString();

describe('Next formatting', () => {
  it('reads due dates as plain phrases', () => {
    expect(formatDue(at(0, 23, 59), now)).toMatch(/^due tonight at /);
    expect(formatDue(at(0, 15), now)).toMatch(/^due today at /);
    expect(formatDue(at(1, 8), now)).toMatch(/^due tomorrow at /);
    expect(formatDue(at(0, 6), now)).toMatch(/^was due at /);
    expect(formatDue(null, now)).toBe('');
  });

  it('keeps the home cue short', () => {
    expect(formatDueShort(at(0, 6), now)).toBe('past due');
    expect(formatDueShort(at(1, 8), now)).toBe('tomorrow');
    expect(formatDueShort(at(0, 23, 59), now)).not.toMatch(/due|tonight/);
  });

  it('joins meta as a sentence, never with middle dots', () => {
    const line = metaSentence(['Chemistry', formatDue(at(1, 8), now), false, '']);
    expect(line).toMatch(/^Chemistry, due tomorrow at /);
    expect(line).not.toContain('·');
  });

  it('formats durations', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(90)).toBe('1 h 30 min');
    expect(formatMinutes(0)).toBe('');
  });
});
