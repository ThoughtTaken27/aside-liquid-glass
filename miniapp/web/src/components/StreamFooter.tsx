import {
  type ActivityMetaProps,
  useActivityElapsed,
} from './ActivityMeta';
import {
  activityHeading,
  type ActivityPhase,
  type WorkKind,
} from '../utils/activityPhase';
import { useSteadyText } from '../hooks/useSteadyText';
import { RaySpinner, RollText } from './Affect';

const LABELS: Record<ActivityPhase, string> = {
  thinking: 'Thinking…',
  working: 'Working…',
  reconnecting: 'Reconnecting…',
  stopping: 'Stopping…',
};

/**
 * The live block before a tool run exists.
 *
 * It uses the same hierarchy as an expandable live run: mark and one
 * orange heading, then quiet measurements. There is no chevron here
 * because there are no steps to reveal yet.
 */
export function StreamFooter({
  phase,
  label,
  work,
  detail = null,
  seed = '',
  startedAt = null,
}: {
  phase: ActivityPhase;
  label?: string;
  work?: WorkKind;
  /** The concrete action, when known. Preferred over the paced verb. */
  detail?: string | null;
  seed?: string;
} & ActivityMetaProps) {
  const elapsed = useActivityElapsed(startedAt);
  const resolvedWork: WorkKind =
    work ??
    (phase === 'thinking'
      ? 'thinking'
      : phase === 'reconnecting'
        ? 'reconnecting'
        : phase === 'stopping'
          ? 'stopping'
          : label
            ? 'tools'
            : 'busy');
  /*
   * Paced, because this is the one line on screen that changes while it
   * is being read. `phase` is a live state, not a settled one, so the
   * dwell stays on for as long as the footer is mounted.
   */
  const heading = useSteadyText(
    activityHeading(resolvedWork, label ?? LABELS[phase], elapsed, seed, detail),
  );

  return (
    <div
      className={`stream-footer is-${phase}`}
      data-content-surface="activity-footer"
      data-activity-state={phase}
    >
      <div className="activity-line" data-activity-role="heading">
        <span className="activity-mark" aria-hidden="true">
          <RaySpinner size={14} />
        </span>
        <span
          className="activity-heading"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <RollText text={heading} shine={phase === 'working' || phase === 'thinking'} />
        </span>
      </div>
    </div>
  );
}
