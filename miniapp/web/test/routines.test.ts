import { describe, expect, it } from 'vitest';
import {
  routineNextRunLabel,
  routineScheduleLabel,
} from '../src/components/RoutinesList';

describe('routineScheduleLabel', () => {
  it('prefers a friendly schedule when one exists', () => {
    expect(routineScheduleLabel({ schedule: 'Weekdays at 9am' })).toBe(
      'Weekdays at 9am',
    );
  });

  it('translates RRULE cadence instead of showing raw RRULE text', () => {
    expect(routineScheduleLabel({ rrule: 'RRULE:FREQ=DAILY' })).toBe(
      'Every day',
    );
    expect(routineScheduleLabel({ rrule: 'FREQ=WEEKLY;INTERVAL=2' })).toBe(
      'Every 2 week',
    );
    expect(routineScheduleLabel({ rrule: 'FREQ=UNKNOWNISH' })).toBe(
      'Repeating schedule',
    );
  });
});

describe('routineNextRunLabel', () => {
  it('formats ISO timestamps as a readable next-run line', () => {
    const label = routineNextRunLabel('2026-09-12T09:30:00-05:00');
    expect(label?.startsWith('Next ')).toBe(true);
    expect(label).not.toContain('2026-09-12T09:30:00');
  });

  it('keeps plain friendly text without doubling the prefix', () => {
    expect(routineNextRunLabel('Next Friday')).toBe('Next Friday');
    expect(routineNextRunLabel('Friday')).toBe('Next Friday');
  });
});
