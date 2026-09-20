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
import { haptic } from '../telegram';

/** Pixels of content travel that arm the refresh. */
const COMMIT_PX = 56;
/** Hard cap on content travel; the finger keeps going without it. */
const MAX_PX = 96;

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
      setPull(COMMIT_PX);
      haptic('light');
      const started = Date.now();
      void Promise.resolve()
        .then(() => onRefresh())
        .catch(() => {
          // A failed refresh still ends: the indicator snapping home is
          // the feedback, and the list keeps whatever it already had.
        })
        .finally(() => {
          // Hold the spinner a beat so a fast refresh still reads as one.
          const hold = Math.max(0, 650 - (Date.now() - started));
          window.setTimeout(() => {
            busy.current = false;
            setRefreshing(false);
            setPull(0);
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
      className={`pull-refresh${live ? ' is-live' : ''}${refreshing ? ' is-refreshing' : ''}`}
    >
      <span className="visually-hidden" role="status">
        {refreshing
          ? 'Refreshing sessions'
          : pull >= COMMIT_PX
            ? 'Release to refresh'
            : ''}
      </span>
      <div className="pull-refresh-indicator" aria-hidden="true">
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
