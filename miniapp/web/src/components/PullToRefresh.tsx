/**
 * Pull to refresh, for the home screen's session list.
 *
 * bencho's "Pull to refresh" block is the reference interaction; the
 * trigger here is the top of `home-scroll`, where a downward pull has no
 * scroll left to spend. Only active while the scroller sits at the very
 * top -- anywhere else the gesture is an ordinary scroll and this stays
 * out of its way.
 *
 * Two details keep it honest:
 *
 *  - The move handler is a NATIVE listener with `{ passive: false }`,
 *    because React attaches touch handlers passively and only a
 *    non-passive listener may `preventDefault()` the native rubber-band.
 *    Without that, iOS would stretch the page under the finger AND move
 *    this indicator, and the two motions would disagree.
 *  - Resistance: the content follows at under half the finger's travel
 *    past a soft cap, so reaching the commit point feels like pulling
 *    against something rather than dragging something loose.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Spinner } from './Icons';
import { EmberSprite } from './EmberSprite';
import { haptic } from '../telegram';

/** Pixels of content travel that arm the refresh. */
const COMMIT_PX = 56;
/** Where the content rests while a refresh runs: the scene's height. */
const HOLD_PX = 68;
/** Hard cap on content travel; the finger keeps going without it. */
const MAX_PX = 96;


/**
 * The pull-to-refresh scene (Clay theme only; hidden elsewhere by CSS).
 *
 * Modelled on Claude for Android's refresh band: a warm grey strip, a
 * dithered pixel skyline on either side, a slightly darker floor, and the
 * clay critter standing on it. Ours adds drifting pixel clouds and, while
 * the refresh runs, parallax (clouds slow, city mid, floor pebbles fast)
 * so the critter reads as walking somewhere. The band reveals with the
 * pull; the critter only drops in once the pull is armed.
 */
/**
 * Claude's clouds, measured off the Android band at 393pt: a long low base,
 * a small bump on the left and a tall stepped bump right of centre.
 * [x, width, height] blocks, bottom-aligned, one tile = one screen width,
 * drawn twice so the walk can scroll seamlessly.
 */
type Block = [x: number, w: number, h: number];
const CLOUDS: Block[] = [
  // left cloud (~59pt wide)
  [86, 59, 5], [89, 8, 9], [104, 25, 13], [108, 17, 16],
  // right cloud (~79pt wide)
  [309, 79, 6], [313, 13, 11], [334, 41, 19], [342, 25, 22],
];
const SKY_TILE = 393;
const SKY_H = 26;
function Clouds() {
  return (
    <svg className="pull-scene-clouds" viewBox={`0 0 ${SKY_TILE * 2} ${SKY_H}`} width={SKY_TILE * 2} height={SKY_H} aria-hidden="true">
      <defs>
        <pattern id="aside-dither" width="1" height="1" patternUnits="userSpaceOnUse">
          <rect width="0.5" height="0.62" fill="currentColor" />
        </pattern>
      </defs>
      {[0, 1].map((tile) =>
        CLOUDS.map(([x, w, h]) => (
          <rect key={`${tile}-${x}-${w}`} x={tile * SKY_TILE + x} y={SKY_H - h} width={w} height={h} fill="url(#aside-dither)" />
        )),
      )}
    </svg>
  );
}
function PullCritter() {
  return (
    <span className="pull-critter">
      <span className="pull-scene-sky">
        <Clouds />
      </span>
      <span className="pull-critter-ground" />
      <span className="pull-critter-dust is-1" />
      <span className="pull-critter-dust is-2" />
      <EmberSprite className="pull-critter-sprite" prefix="pull-critter" width={44} />
    </span>
  );
}

export function PullToRefresh({
  scroller,
  onRefresh,
  disabled,
  children,
}: {
  /** The scroll container whose top edge gates the gesture. */
  scroller: RefObject<HTMLElement | null>;
  /** Awaited before the indicator snaps home. */
  onRefresh: () => void | Promise<void>;
  disabled?: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [active, setActive] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // The beat after a refresh lands, while the page springs home: lets the
  // critter leap out with the content instead of just vanishing.
  const [finishing, setFinishing] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const gesture = useRef<{ y0: number; active: boolean } | null>(null);
  const armed = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    const el = root.current;
    if (!el || disabled) return undefined;

    const start = (event: TouchEvent) => {
      const sc = scroller.current;
      if (!sc || busy.current || sc.scrollTop > 0) {
        gesture.current = null;
        return;
      }
      // A second finger landing mid-pull must not re-anchor the gesture
      // (the content would jump to the new finger's origin).
      if (gesture.current || event.touches.length > 1) {
        gesture.current = null;
        return;
      }
      gesture.current = { y0: event.touches[0].clientY, active: false };
      armed.current = false;
    };

    const move = (event: TouchEvent) => {
      const g = gesture.current;
      const sc = scroller.current;
      if (!g || !sc) return;
      const dy = event.touches[0].clientY - g.y0;
      if (!g.active) {
        // Not yet a pull: a small dead zone, and upward movement is never
        // this gesture (at scrollTop 0 there is nowhere up to go, so let
        // the scroller have the touch back).
        if (dy < 8) return;
        g.active = true;
        setActive(true);
      }
      // From here the touch is ours: hold the native rubber-band still so
      // the indicator is the only thing moving.
      event.preventDefault();
      // Resistance past the commit point: the first COMMIT_PX track at
      // 55%, everything after at 22%, capped.
      const tracked =
        dy <= COMMIT_PX
          ? dy * 0.55
          : COMMIT_PX * 0.55 + (dy - COMMIT_PX) * 0.22;
      const next = Math.min(MAX_PX, tracked);
      if ((next >= COMMIT_PX) !== armed.current) {
        armed.current = next >= COMMIT_PX;
        haptic('select');
      }
      setPull(next);
    };

    const end = () => {
      const g = gesture.current;
      gesture.current = null;
      setActive(false);
      // A cancel arriving mid-refresh (an interruption, not a release)
      // leaves the hold alone: the refresh's own finally() owns the reset.
      if (busy.current) return;
      if (!g?.active) {
        setPull(0);
        return;
      }
      if (!armed.current || busy.current) {
        setPull(0);
        return;
      }
      busy.current = true;
      setRefreshing(true);
      setPull(HOLD_PX);
      haptic('light');
      const started = Date.now();
      void Promise.resolve()
        .then(() => onRefresh())
        .catch(() => {
          // A failed refresh still ends: the indicator snapping home is
          // the feedback, and the list keeps whatever it already had.
        })
        .finally(() => {
          // Hold the walk a beat so a fast refresh still reads as one, then
          // a short celebration (stop, smile, hop) before the page springs
          // home. Reduced motion skips straight to the close.
          const hold = Math.max(0, 1100 - (Date.now() - started));
          const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
          window.setTimeout(() => {
            setRefreshing(false);
            setCelebrating(!calm);
            window.setTimeout(
              () => {
                busy.current = false;
                setCelebrating(false);
                setFinishing(true);
                setPull(0);
                window.setTimeout(() => setFinishing(false), 720);
              },
              calm ? 0 : 560,
            );
          }, hold);
        });
    };

    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
    // `onRefresh` is read fresh through the closure each gesture; the
    // listeners themselves are stable for the life of the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  const live = pull > 0 || refreshing;

  return (
    <div
      ref={root}
      className={`pull-refresh${live ? ' is-live' : ''}${refreshing ? ' is-refreshing' : ''}${
        pull >= COMMIT_PX && !refreshing ? ' is-armed' : ''
      }${active && !refreshing ? ' is-dragging' : ''}${finishing ? ' is-finishing' : ''}${celebrating ? ' is-celebrating' : ''}`}
      style={{ ['--pull-px' as string]: `${pull.toFixed(1)}px` }}
    >
      <span className="visually-hidden" role="status">
        {refreshing
          ? 'Refreshing sessions'
          : pull >= COMMIT_PX
            ? 'Release to refresh'
            : ''}
      </span>
      <div className="pull-refresh-indicator" aria-hidden="true">
        <PullCritter />
        {refreshing ? (
          <Spinner size={16} />
        ) : (
          <span
            className={`pull-refresh-arrow${pull >= COMMIT_PX ? ' is-armed' : ''}`}
          >
            ↓
          </span>
        )}
        <span className="pull-refresh-text">
          {refreshing
            ? 'Refreshing…'
            : pull >= COMMIT_PX
              ? 'Release to refresh'
              : 'Pull to refresh'}
      </span>
      </div>
      <div
        className="pull-refresh-content"
        style={{
          // A margin, not a transform: the wrapper clips the indicator's
          // resting place (see the stylesheet), and a transform would slide
          // the content under that same clip. No transition while the
          // finger owns the motion; the snap home and the hold at the
          // commit point animate via the stylesheet.
          marginTop: `${pull.toFixed(1)}px`,
          transition: active && !refreshing ? 'none' : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}
