import { describe, expect, it } from 'vitest';

describe('senderLine', async () => {
  const { senderLine } = await import('./nextFormat');
  it('says who really sent it', () => {
    expect(senderLine({ host: 'school.example', tier: 'district' })).toBe('From the school, verified');
    expect(senderLine({ host: 'students.school.example', tier: 'student' })).toBe('From a student account, students.school.example');
    expect(senderLine({ host: 'school.example', tier: 'outside', schoolDomain: true })).toBe('school.example address, sender not confirmed');
    expect(senderLine({ host: 'win-now.biz', tier: 'outside' })).toBe('From outside the school, win-now.biz');
    expect(senderLine({ host: 'school.example', tier: 'outside' })).toBe('From outside the school, school.example');
    expect(senderLine(null)).toBe('From school email');
  });
});
