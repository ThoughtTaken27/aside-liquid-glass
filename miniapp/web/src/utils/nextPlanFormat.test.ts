import { describe, expect, it } from 'vitest';
import { dayLabel, hm, hours, isWeekendDay, shortDay } from './nextPlanFormat';

describe('nextPlanFormat', () => {
  const now = new Date(2026, 8, 25, 18, 0); // Friday

  it('formats minutes', () => {
    expect(hm(0)).toBe('0 min');
    expect(hm(45)).toBe('45 min');
    expect(hm(60)).toBe('1 h');
    expect(hm(95)).toBe('1 h 35 min');
    expect(hours(90)).toBe('1.5 h');
    expect(hours(2398)).toBe('40 h');
  });

  it('labels days relative to now', () => {
    expect(dayLabel('2026-09-25', now)).toBe('Today');
    expect(dayLabel('2026-09-26', now)).toBe('Tomorrow');
    expect(dayLabel('2026-09-28', now)).toBe('Monday');
    expect(dayLabel('2026-10-15', now)).toMatch(/Oct 15/);
  });

  it('reads plain days as local dates', () => {
    expect(shortDay('2026-10-15')).toBe('Oct 15');
    expect(isWeekendDay('2026-09-26')).toBe(true);
    expect(isWeekendDay('2026-09-28')).toBe(false);
  });
});
