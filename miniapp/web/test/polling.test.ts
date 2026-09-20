import { afterEach, describe, expect, it, vi } from 'vitest';
import { startVisiblePolling, type VisibilitySource } from '../src/utils/polling';

class FakeVisibility implements VisibilitySource {
  visibilityState: DocumentVisibilityState = 'visible';
  private listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  set(next: DocumentVisibilityState): void {
    this.visibilityState = next;
    for (const listener of this.listeners) listener();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startVisiblePolling', () => {
  it('schedules the next refresh only after the current one settles', async () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibility();
    let finish!: () => void;
    const task = vi.fn(
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const stop = startVisiblePolling(task, 8_000, visibility);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(task).toHaveBeenCalledTimes(1);

    finish();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does no periodic work while the document is hidden', async () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibility();
    visibility.visibilityState = 'hidden';
    const task = vi.fn(async () => undefined);
    const stop = startVisiblePolling(task, 8_000, visibility);

    await vi.advanceTimersByTimeAsync(80_000);
    expect(task).not.toHaveBeenCalled();
    stop();
  });

  it('refreshes immediately on return and cleanup prevents later work', async () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibility();
    visibility.visibilityState = 'hidden';
    const task = vi.fn(async () => undefined);
    const stop = startVisiblePolling(task, 8_000, visibility);

    visibility.set('visible');
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(80_000);
    visibility.set('hidden');
    visibility.set('visible');
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
  });
});
