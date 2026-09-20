import { useEffect, useState } from 'react';
import { formatTokens } from '../utils/format';
import { workedFor } from '../utils/time';
import { CountUp } from './CountUp';

/** A turn cannot have started a day ago; a clock that says so is skewed. */
const MAX_PLAUSIBLE_TURN_MS = 24 * 60 * 60 * 1000;

export interface ActivityMetaProps {
  /** Turn start from the transcript; mount time is the fallback. */
  startedAt?: number | null;
  /** Output tokens produced since the last user message. */
  tokens?: number;
}

/**
 * One clock shared by the active heading and its measurements.
 *
 * The heading uses elapsed time to rotate its verb, and the row below uses
 * the same value for its clock. Keeping the time in their parent prevents
 * two timers from crossing a twelve-second boundary on different frames.
 */
export function useActivityElapsed(
  startedAt: number | null = null,
  enabled = true,
): number {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  const claimed = startedAt && startedAt > 0 ? startedAt : 0;
  const drift = mountedAt - claimed;
  const from =
    claimed && drift >= -2_000 && drift < MAX_PLAUSIBLE_TURN_MS
      ? claimed
      : mountedAt;

  return Math.max(0, now - from);
}

/**
 * Quiet measurements under the single live heading.
 *
 * This row deliberately says only what can be measured: elapsed time and,
 * once there is a non-zero reading, generated tokens. The activity verb,
 * Aside mark, and motion all live in the heading above, so the status is
 * stated once instead of echoed in two visual treatments.
 */
export function ActivityMeta({
  elapsedMs,
  tokens = 0,
}: {
  elapsedMs: number;
  tokens?: number;
}) {
  return (
    /* Outside any live region on purpose. A ticking clock must not turn a
       screen reader into a metronome. */
    <div className="activity-meta" data-activity-role="meta">
      <span className="activity-meta-time" data-meta-value="elapsed">
        {workedFor(elapsedMs)}
      </span>
      {/* Zero is not a reading. */}
      {tokens > 0 ? (
        <>
          <span className="activity-meta-sep" aria-hidden="true">·</span>
          <span className="activity-meta-count" data-meta-value="tokens">
            <CountUp value={tokens} format={formatTokens} /> tokens
          </span>
        </>
      ) : null}
    </div>
  );
}
