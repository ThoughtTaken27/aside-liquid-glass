import { describe, expect, it } from 'vitest';
import { ruleSpace, suggestSpace } from '../src/spacehint.js';

const COURSES = ['AP English Literature', 'Calculus Honors', 'Arch & Eng Dsn III', 'AP Computer Science A', 'AP Physics I'];

describe('space suggestion', () => {
  it('reads the obvious ones with plain rules', () => {
    expect(ruleSpace('Email Mr. Rhodes about the letter', COURSES)?.space).toBe('school');
    expect(ruleSpace('Finish physics worksheet', COURSES)?.space).toBe('school');
    expect(ruleSpace('Call Mom about dinner', COURSES)?.space).toBe('personal');
    expect(ruleSpace('Common App activities list', COURSES)?.space).toBe('personal');
  });

  it('uses his real class names', () => {
    expect(ruleSpace('Literature reading response', COURSES)?.space).toBe('school');
  });

  it('leaves mixed or unclear titles for Jev, and returns nothing without it', async () => {
    expect(ruleSpace('Ask Mom about the calc test', COURSES)).toBeNull();
    expect(ruleSpace('Finish Loophole essay draft', COURSES)).toBeNull();
    expect(await suggestSpace('Figure out Saturday', COURSES, null)).toBeNull();
  });
});
