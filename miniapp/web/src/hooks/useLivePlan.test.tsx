import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const next = vi.fn();
vi.mock('../api', () => ({ api: { next: () => next() } }));

import { backoffMs, planFingerprint, useLivePlan } from './useLivePlan';
import type { NextPlan } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plan = (title: string, at = '2026-09-26T10:00:00Z') =>
  ({ generatedAt: at, now: { id: 'a', title }, next: [], later: [], review: [], notices: [], sources: [], unsure: [], withAside: [], doneToday: [] }) as unknown as NextPlan;

let seen: ReturnType<typeof useLivePlan>[] = [];
function Probe() {
  seen.push(useLivePlan());
  return null;
}

let root: Root;
let host: HTMLDivElement;
const last = () => seen[seen.length - 1];
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  next.mockReset();
  seen = [];
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useLivePlan', () => {
  it('backs off 2s, 4s, 8s and caps at 60s', () => {
    expect([1, 2, 3, 4, 10].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 60000]);
  });

  it('ignores the server timestamp when deciding whether anything changed', () => {
    expect(planFingerprint(plan('x', 'a'))).toBe(planFingerprint(plan('x', 'b')));
    expect(planFingerprint(plan('x'))).not.toBe(planFingerprint(plan('y')));
  });

  it('opens from the saved plan, says so when the Mac is down, and heals on its own', async () => {
    localStorage.setItem('next.plan.v1', JSON.stringify({ at: 1, plan: plan('saved') }));
    next.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(plan('fresh'));
    act(() => root.render(<Probe />));
    expect(seen[0].plan?.now?.title).toBe('saved'); // instant, before any network
    await flush();
    expect(last().state).toBe('offline');
    expect(last().plan?.now?.title).toBe('saved'); // still showing the list
    await flush(2000); // first retry, no user action
    expect(last().state).toBe('live');
    expect(last().plan?.now?.title).toBe('fresh');
    expect(JSON.parse(localStorage.getItem('next.plan.v1')!).plan.now.title).toBe('fresh');
  });

  it('does not re-render when a refresh brings the same plan', async () => {
    next.mockResolvedValue(plan('same'));
    act(() => root.render(<Probe />));
    await flush();
    const renders = seen.length;
    next.mockResolvedValue(plan('same', '2026-09-26T10:01:00Z'));
    await flush(60_000);
    expect(next).toHaveBeenCalledTimes(2);
    expect(seen.length).toBe(renders);
  });

  it('abandons a request that hangs and tries again', async () => {
    next.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(plan('ok'));
    act(() => root.render(<Probe />));
    await flush(15_000);
    expect(last().state).toBe('offline');
    await flush(2000);
    expect(last().plan?.now?.title).toBe('ok');
  });

  it('shares one request when loads overlap', async () => {
    let resolve!: (p: NextPlan) => void;
    next.mockReturnValue(new Promise<NextPlan>((r) => (resolve = r)));
    act(() => root.render(<Probe />));
    void last().load();
    void last().load();
    expect(next).toHaveBeenCalledTimes(1);
    resolve(plan('one'));
    await flush();
  });

  it('stops polling while hidden and refreshes when shown again', async () => {
    next.mockResolvedValue(plan('p'));
    act(() => root.render(<Probe />));
    await flush();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush(5 * 60_000);
    expect(next).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(next).toHaveBeenCalledTimes(2);
  });
});
