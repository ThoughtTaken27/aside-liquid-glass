import { useEffect, useRef, useState } from 'react';

/**
 * The shortest time a status phrase is allowed to stay on screen.
 *
 * Reading three words takes roughly half a second, and noticing that they
 * changed takes longer than reading them. Anything that turns over faster
 * than that is not communicating, it is just moving -- which is what made
 * the live row feel broken rather than busy.
 *
 * 1.6s is the low end of comfortable: long enough that every phrase is
 * legible and the row reads as deliberate, short enough that a real
 * change still lands while it is still true. Above ~2.5s the row starts
 * lagging the work it describes, which is the opposite failure.
 */
export const STEADY_DWELL_MS = 1_600;

/**
 * Hold a value still for a minimum beat.
 *
 * Upstream state here is genuinely fast: tool starts and stops arrive
 * several times a second, and each one is a legitimate change. The
 * problem is not that the data is wrong, it is that a human cannot read
 * at that rate, so honest updates add up to an unreadable row.
 *
 * Rather than debounce -- which delays every change including the first,
 * and leaves the row blank or stale exactly when something starts -- this
 * commits the first change immediately and then rate-limits. A change
 * arriving inside the dwell is not dropped; it is parked, and the most
 * recent one lands when the beat is up. So the row is always current
 * within one dwell, and never changes twice inside one.
 *
 * `active` exists because a settled row must not be rate-limited: when a
 * turn ends the heading becomes the final tally, and that should appear
 * at once rather than a beat later.
 */
export function useSteadyText(text: string, active = true): string {
  const [shown, setShown] = useState(text);
  const shownAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const clear = () => {
      if (timer.current === undefined) return;
      window.clearTimeout(timer.current);
      timer.current = undefined;
    };

    // Settled, or the value caught up on its own. Either way, nothing to pace.
    if (!active) {
      clear();
      shownAt.current = 0;
      setShown(text);
      return;
    }
    if (text === shown) return;

    const wait = Math.max(0, shownAt.current + STEADY_DWELL_MS - Date.now());
    if (wait === 0) {
      // First change of a run, or the last one is old enough to replace.
      shownAt.current = Date.now();
      setShown(text);
      return;
    }

    // Park it. A newer value before the beat is up replaces this timer
    // rather than queueing behind it, so the row never plays catch-up
    // through a backlog of phrases nobody saw.
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      shownAt.current = Date.now();
      setShown(text);
    }, wait);
    return clear;
  }, [text, active, shown]);

  return active ? shown : text;
}
