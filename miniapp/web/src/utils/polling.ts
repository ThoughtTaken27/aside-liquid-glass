export interface VisibilitySource {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Poll after each completed task while the page is visible.
 *
 * Scheduling from completion prevents a slow tailnet request from piling up
 * behind later interval ticks. Visibility handling keeps an installed app
 * in a pocket from waking the Mac every eight seconds, then refreshes at
 * once when the user returns.
 */
export function startVisiblePolling(
  task: () => void | Promise<void>,
  intervalMs: number,
  visibility: VisibilitySource = document,
): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    if (stopped || running || visibility.visibilityState !== 'visible') return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, intervalMs);
  };

  const run = async () => {
    if (stopped || running || visibility.visibilityState !== 'visible') return;
    running = true;
    try {
      await task();
    } catch {
      // Polling is best-effort. The screen keeps its last good data.
    } finally {
      running = false;
      schedule();
    }
  };

  const onVisibilityChange = () => {
    clearTimer();
    if (visibility.visibilityState === 'visible') void run();
  };

  visibility.addEventListener('visibilitychange', onVisibilityChange);
  schedule();

  return () => {
    stopped = true;
    clearTimer();
    visibility.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
