/**
 * The composer's living edge.
 *
 * libraries.dev's voice-glow wraps the composer box: while dictating, the
 * mic level drives the glow; while a turn runs or a clip transcribes,
 * `processing` gathers it into the traveling beam. One working signal, in
 * the sunset palette that matches the brand.
 *
 * Cost control. The library's driver repaints every frame (canvas band, SVG
 * displacement, a dozen CSS variables) even while nothing is happening, just
 * to keep a soft idle "breathing". Measured on an M1 that was ~100 ms of
 * main-thread script per second with the app sitting idle, several times
 * that on a phone, on every screen that shows a composer. So at rest the
 * beam is `paused`: it settles for a moment, then holds its last frame and
 * does no per-frame work until voice or a turn wakes it.
 *
 * The level comes from the recorder's own analyser as a getter, sampled by
 * the driver without re-rendering, so dictation runs one audio graph, not
 * two.
 *
 * The canvas and SVG gates render the box untouched where the effect cannot
 * run (notably jsdom), so the glow is progressive enhancement rather than a
 * boot dependency.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { VoiceBeam } from 'voice-glow';

/** Long enough for the glow to fade back to rest before it freezes. */
const SETTLE_MS = 1_600;

const GLOW_OK =
  typeof document !== 'undefined' &&
  (() => {
    try {
      if (!document.createElement('canvas').getContext('2d')) return false;
      // The warp layer drives feDisplacementMap/feOffset through their
      // SVGAnimatedNumber props. jsdom's SVG elements are stubs without
      // them, and mounting the beam there throws from the driver loop.
      const NS = 'http://www.w3.org/2000/svg';
      const probe = document.createElementNS(NS, 'feDisplacementMap') as unknown as Record<
        string,
        unknown
      >;
      return typeof probe.scale === 'object' && probe.scale !== null;
    } catch {
      return false;
    }
  })();

export function VoiceGlow({
  children,
  level,
  processing,
}: {
  children: ReactNode;
  level: (() => number) | null;
  processing: boolean;
}) {
  const live = Boolean(level) || processing;
  const [paused, setPaused] = useState(!live);

  useEffect(() => {
    if (live) {
      setPaused(false);
      return;
    }
    const timer = window.setTimeout(() => setPaused(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [live]);

  if (!GLOW_OK) return <>{children}</>;
  return (
    <VoiceBeam
      level={level ?? 0}
      processing={processing}
      paused={paused && !live}
      colorVariant="sunset"
    >
      {children}
    </VoiceBeam>
  );
}
