/**
 * The live turn as a floating island above the composer.
 *
 * beUI's Dynamic Island block is the reference: one pill that morphs
 * between a compact readout and an expanded live-activity view, with the
 * shell resizing on a long ease and the content swapping through a
 * rise-and-fade. No motion library here, so the spring is a long
 * cubic-bezier and the crossfade is a keyed re-mount -- the same
 * perceptual recipe, in CSS. (Opacity and transform only: the glass audit
 * forbids `filter: blur` anywhere past the standalone artwork field.)
 *
 * Why it exists when the transcript tail already shows the same status:
 * the tail scrolls away. Mid-turn, reading back through history leaves no
 * indication anything is running and no way to stop it without scrolling
 * home. The island is pinned above the composer whenever a turn is live,
 * and hides itself at the tail (via the footer's `data-at-end`, in CSS,
 * costing no re-render) where the full footer already says everything.
 *
 * Compact: orb, elapsed clock, expander. Expanded: the paced heading (the
 * thinking summary) and the quiet measurements. No stop control: the
 * composer's own stop sits directly underneath, and two stop buttons a
 * thumb apart is one too many.
 */
import { useState } from 'react';
import { ActivityOrb } from './ActivityOrb';
import {
  ActivityMeta,
  useActivityElapsed,
} from './ActivityMeta';
import { activityHeading, type WorkKind } from '../utils/activityPhase';
import { workedFor } from '../utils/time';
import { useSteadyText } from '../hooks/useSteadyText';
import { ChevronUp } from './Icons';
import { haptic } from '../telegram';

export interface IslandActivity {
  label: string;
  work: WorkKind;
  detail?: string | null;
  seed?: string;
  startedAt?: number | null;
  tokens?: number;
}

export function ActivityIsland({ activity }: { activity: IslandActivity }) {
  const [expanded, setExpanded] = useState(false);
  const elapsed = useActivityElapsed(activity.startedAt ?? null, true);
  const heading = useSteadyText(
    activityHeading(
      activity.work,
      activity.label,
      elapsed,
      activity.seed,
      activity.detail ?? null,
    ),
  );

  return (
    <div
      className={`activity-island${expanded ? ' is-expanded' : ''}`}
      data-activity-state="running"
    >
      <button
        type="button"
        className="activity-island-main"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse turn status' : 'Expand turn status'}
        onClick={() => {
          haptic('light');
          setExpanded((prev) => !prev);
        }}
      >
        <span className="activity-mark" aria-hidden="true">
          <ActivityOrb work={activity.work} />
        </span>
        {/*
          Keyed so expanding swaps the content with a rise-and-fade
          instead of reflowing one line into another.
        */}
        <span
          key={expanded ? 'full' : 'compact'}
          className="activity-island-text"
        >
          {expanded ? (
            <span className="activity-island-heading">{heading}</span>
          ) : (
            <span className="activity-island-clock">{workedFor(elapsed)}</span>
          )}
        </span>
        <span
          className={`activity-island-chevron${expanded ? ' is-open' : ''}`}
          aria-hidden="true"
        >
          <ChevronUp size={14} strokeWidth={2} />
        </span>
      </button>

      {expanded ? (
        <div className="activity-island-detail">
          <ActivityMeta elapsedMs={elapsed} tokens={activity.tokens ?? 0} />
        </div>
      ) : null}
    </div>
  );
}
