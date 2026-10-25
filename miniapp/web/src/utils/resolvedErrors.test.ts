import { describe, expect, it } from 'vitest';
import type { ThreadItem } from '../types';
import { withoutResolvedErrors } from './resolvedErrors';

const user: ThreadItem = { kind: 'user', id: 'u', text: 'hi', ts: 1 };
const err = (id: string): ThreadItem => ({
  kind: 'error', id, text: 'Request timed out.', ts: 2,
  alert: { title: 'There was an error while running the task', description: 'Request timed out.', detail: '', tone: 'destructive' },
});
const answer: ThreadItem = { kind: 'answer', id: 'a', text: 'done', ts: 3 } as ThreadItem;

describe('withoutResolvedErrors', () => {
  it('keeps an error that stopped the turn', () => {
    const items = [user, err('e')];
    expect(withoutResolvedErrors(items, false)).toBe(items);
  });
  it('hides the error while the turn is running again', () => {
    expect(withoutResolvedErrors([user, err('e')], true)).toEqual([user]);
  });
  it('hides an error once later work or an answer follows it', () => {
    expect(withoutResolvedErrors([user, err('e'), answer], false)).toEqual([user, answer]);
  });
  it('keeps every trailing error and drops earlier recovered ones', () => {
    expect(withoutResolvedErrors([err('e1'), user, err('e2')], false).map((i) => i.id)).toEqual(['u', 'e2']);
  });
  it('returns the same array when there is no error', () => {
    const items = [user, answer];
    expect(withoutResolvedErrors(items, true)).toBe(items);
  });
});
