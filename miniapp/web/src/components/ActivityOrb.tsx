import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import type { ActivityPhase, WorkKind } from '../utils/activityPhase';

/**
 * A small, semantic motion signal for the one activity line that is live.
 *
 * The orb changes vocabulary with the work instead of becoming generic
 * decoration: reasoning breathes, tools scan, writing composes, and a lost
 * connection rewires itself. The package freezes itself for reduced-motion,
 * off-screen, and background-tab states, so this stays cheap on a phone.
 */
export function ActivityOrb({
  work,
  phase,
}: {
  work: WorkKind;
  phase?: ActivityPhase;
}) {
  const state: OrbState =
    phase === 'reconnecting' || work === 'reconnecting'
      ? 'connecting'
      : work === 'tools'
        ? 'searching'
        : work === 'writing'
          ? 'composing'
          : work === 'thinking'
            ? 'breathing'
            : 'working';

  const paused = phase === 'stopping' || work === 'stopping';

  return (
    <ThinkingOrb
      state={state}
      size={20}
      speed={state === 'searching' ? 0.86 : 0.78}
      paused={paused}
      className="activity-orb"
      data-orb-state={state}
      data-orb-paused={paused ? 'true' : 'false'}
      aria-hidden="true"
    />
  );
}
