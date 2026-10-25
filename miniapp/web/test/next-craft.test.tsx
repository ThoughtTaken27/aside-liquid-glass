import { describe, expect, it } from 'vitest';
import { runsOf } from '../src/components/NextActivity';
import type { LedgerEntry } from '../src/types';

const e = (seq: number, summary: string, extra: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ seq, at: new Date(2026, 9, 17, 20, 60 - seq).toISOString(), actor: 'next', summary, ...extra }) as LedgerEntry;

describe('Next activity runs', () => {
  it('folds back-to-back identical entries into one run, newest first', () => {
    const runs = runsOf([e(1, 'Sorted school email'), e(2, 'Sorted school email'), e(3, 'Sorted school email'), e(4, 'Paused')]);
    expect(runs.map((r) => r.length)).toEqual([3, 1]);
    expect(runs[0][0].seq).toBe(1);
  });

  it('never folds a risky entry or one tied to a chat', () => {
    const runs = runsOf([e(1, 'Sent'), e(2, 'Sent', { risk: 'high' } as Partial<LedgerEntry>), e(3, 'Sent', { sessionId: 'ses_1' } as Partial<LedgerEntry>), e(4, 'Sent')]);
    expect(runs.map((r) => r.length)).toEqual([1, 1, 1, 1]);
  });

  it('keeps different summaries and different actors apart', () => {
    const runs = runsOf([e(1, 'A'), e(2, 'B'), e(3, 'B', { actor: 'you' } as Partial<LedgerEntry>)]);
    expect(runs.length).toBe(3);
  });
});
