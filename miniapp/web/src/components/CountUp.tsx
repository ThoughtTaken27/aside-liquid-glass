/**
 * A number that rolls to its new value instead of jumping.
 *
 * TypeUI's number catalogue (ease roll, spring roll, slot machine) and
 * beUI's number primitives agree that counted things should move. The one
 * counted thing on screen here is the token count under the live heading,
 * which ticks upward through a turn -- jumping from 1.2k to 1.8k reads as
 * a glitch, rolling reads as progress.
 *
 * A short rAF tween with an ease-out, not a spring: the value changes at
 * most once a second (socket metadata ticks), so anything bouncier would
 * still be settling when the next value lands. Reduced-motion jumps
 * straight to the value.
 */
import { useEffect, useRef, useState } from 'react';

const DURATION_MS = 550;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  );
}

export function CountUp({
  value,
  format,
}: {
  /** The raw target value; formatting happens per frame. */
  value: number;
  format: (n: number) => string;
}) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      from.current = value;
      setShown(value);
      return undefined;
    }
    const start = from.current;
    if (start === value) return undefined;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / DURATION_MS);
      // Ease-out cubic: fast off the mark, settles into the value.
      const eased = 1 - Math.pow(1 - t, 3);
      const current = start + (value - start) * eased;
      from.current = current;
      setShown(current);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);

  return <>{format(shown)}</>;
}
