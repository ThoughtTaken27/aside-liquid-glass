/**
 * The composer's living edge.
 *
 * libraries.dev's voice-glow wraps the composer box: while dictating, the
 * mic stream drives the glow directly (level plus low/mid/high bands, so
 * a voice ripples outward from the centre); while a turn runs or a clip
 * transcribes, `processing` gathers it into the traveling beam -- the
 * border-beam line confined to the glow, which is why the hand-rolled
 * conic ring this file replaces is gone rather than kept alongside. One
 * working signal, in the sunset palette that matches the brand.
 *
 * Two gates keep it honest. The canvas check renders the box untouched
 * where there is no 2d context (notably jsdom, where half the test suite
 * mounts a Composer), so the glow is progressive enhancement rather than
 * a boot dependency. And the library itself pauses off-screen, shares one
 * driver across every mounted beam, and holds its colours still under
 * `prefers-reduced-motion`.
 */
import type { ReactNode } from 'react';
import { VoiceBeam } from 'voice-glow';

const GLOW_OK =
  typeof document !== 'undefined' &&
  (() => {
    try {
      if (!document.createElement('canvas').getContext('2d')) return false;
      // The warp layer drives feDisplacementMap/feOffset through their
      // SVGAnimatedNumber props. jsdom's SVG elements are stubs without
      // them, and mounting the beam there throws from the driver loop --
      // so their absence also means "render the plain box". Every real
      // browser has had them since SVG 1.1.
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
  stream,
  processing,
}: {
  children: ReactNode;
  stream: MediaStream | null;
  processing: boolean;
}) {
  if (!GLOW_OK) return <>{children}</>;
  return (
    <VoiceBeam stream={stream} processing={processing} colorVariant="sunset">
      {children}
    </VoiceBeam>
  );
}
