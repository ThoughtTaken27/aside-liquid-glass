import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ActivityTab } from '../src/components/NextActivity';
import { api } from '../src/api';
vi.mock('../src/api', () => ({ api: { nextSafety: vi.fn(), nextActivity: vi.fn() } }));
vi.mock('../src/components/NextContext', () => ({ NextContext: () => null }));
vi.mock('../src/components/Toasts', () => ({ toast: vi.fn() }));
const safety = () => ({ control: { paused: false }, running: [], parts: [], ledger: { ok: true, count: 0, checkedAt: new Date().toISOString() } });
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); vi.mocked(api.nextSafety).mockResolvedValue(safety() as never); vi.mocked(api.nextActivity).mockResolvedValue({ entries: [], more: false }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const flush = async () => { await act(async () => {}); };
describe('activity refresh is not a parent-render feedback loop', () => {
 it('does not reload when the parent supplies a new callback identity', async () => {
  const first = vi.fn(), next = vi.fn(); const view = render(<ActivityTab onPausedChange={first} />); await flush();
  expect(api.nextSafety).toHaveBeenCalledTimes(1); expect(first).toHaveBeenCalledTimes(1);
  view.rerender(<ActivityTab onPausedChange={next} />); await flush();
  expect(api.nextSafety).toHaveBeenCalledTimes(1); expect(api.nextActivity).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(api.nextSafety).toHaveBeenCalledTimes(2); expect(next).not.toHaveBeenCalled();
 });
 it('notifies the latest callback only when paused state changes', async () => {
  const first = vi.fn(), next = vi.fn(); const view = render(<ActivityTab onPausedChange={first} />); await flush();
  view.rerender(<ActivityTab onPausedChange={next} />); await flush();
  vi.mocked(api.nextSafety).mockResolvedValue({ ...safety(), control: { paused: true } } as never);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(next).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledWith(true);
 });
 it('stops passive polling while hidden and refreshes on return', async () => {
  render(<ActivityTab />); await flush();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
  expect(api.nextActivity).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange'))); await flush();
  expect(api.nextActivity).toHaveBeenCalledTimes(2);
 });
});
