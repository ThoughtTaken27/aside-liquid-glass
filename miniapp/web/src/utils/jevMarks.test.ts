import { describe, expect, it } from 'vitest';
import { alsoLine, doneHintLine, estLabel, flagLine } from './jevMarks';

describe('Jev hint wording', () => {
  it('names a Schoology flag as Schoology, not email', () => {
    expect(flagLine({ flag: 'suspicious', flagReason: 'reads like orders to an AI (Jev check)', source: 'schoology' })).toMatch(/^This Schoology text/);
    expect(flagLine({ flag: 'suspicious', flagReason: null, source: 'school-mail' })).toMatch(/^This email looks suspicious/);
    expect(flagLine({ flag: null, flagReason: null, source: 'schoology' })).toBeNull();
  });
  it('says where a folded twin came from, once', () => {
    expect(alsoLine({ alsoFrom: [{ id: 'school-mail:1', source: 'school-mail', title: 'Reminder: Gatsby' }] })).toBe('Also came in by school email: “Reminder: Gatsby”. Shown once.');
    expect(alsoLine({ alsoFrom: [] })).toBeNull();
  });
  it('quotes the receipt and when it came', () => {
    const now = new Date(2026, 8, 27, 12);
    expect(doneHintLine({ doneHint: { subject: 'Submission received', at: new Date(2026, 8, 26, 21).toISOString(), p: 0.96 } }, now)).toBe('An email yesterday reads like it\'s already done: “Submission received”.');
  });
  it('marks a guessed time as a guess', () => {
    expect(estLabel({ estBy: 'jev' }, '45 min')).toBe('About 45 min, a guess');
    expect(estLabel({}, '45 min')).toBe('About 45 min');
  });
});
