/**
 * Swipe a row left to reveal a destructive action.
 *
 * Why a gesture rather than a trailing "…" button on every row: a visible
 * per-row menu button is permanent visual noise on a list whose whole job
 * is to be scanned, and it puts a 34px tap target inside a row that is
 * itself a tap target. The swipe is invisible until it is wanted, which is
 * the right trade for an action taken rarely.
 *
 * Three things make this feel like the OS rather than like a webview:
 *
 *  - **Axis locking.** The first few pixels of a drag decide whether it is
 *    a scroll or a swipe, and once decided it does not change. Without
 *    this, a fast vertical flick that starts with 3px of horizontal drift
 *    peels rows open behind the user's thumb.
 *  - **Rubber banding.** Dragging past the action's width keeps moving,
 *    but at a third of the rate. A hard stop reads as a bug; resistance
 *    reads as a limit.
 *  - **One row open at a time.** Opening a row closes whatever was open,
 *    via a module-level registry rather than lifted state, so the list
 *    does not re-render every row to close one.
 *
 * Deliberately NOT a swipe-all-the-way-to-commit gesture. Delete has no
 * in-app undo here (the server archives, which is recoverable on the
 * desktop, but nothing in this app surfaces that), so committing it needs
 * a second deliberate tap.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { haptic } from '../telegram';

/** How far the row slides to fully expose the action. */
const ACTION_WIDTH = 88;
/** Past the action's width the row keeps moving, at this fraction. */
const RUBBER = 0.32;
/** Horizontal travel before the gesture commits to being a swipe. */
const AXIS_LOCK = 10;
/** Past this, releasing snaps open rather than closed. */
const OPEN_THRESHOLD = ACTION_WIDTH * 0.45;

/**
 * The currently open row's closer.
 *
 * Module-level on purpose: the alternative is an open-id in a parent, which
 * makes closing one row a re-render of the whole list.
 */
let closeOpenRow: (() => void) | null = null;

export interface SwipeToDeleteProps {
  children: ReactNode;
  onDelete: () => void | Promise<void>;
  label: string;
  icon?: ReactNode;
  /** When false this is a plain passthrough with no gesture attached. */
  enabled?: boolean;
}

export function SwipeToDelete({
  children,
  onDelete,
  label,
  icon,
  enabled = true,
}: SwipeToDeleteProps) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Gesture bookkeeping. Refs rather than state: these change on every
  // touchmove and none of them should cause a render.
  const startX = useRef(0);
  const startY = useRef(0);
  const startOffset = useRef(0);
  const axis = useRef<'undecided' | 'x' | 'y'>('undecided');
  const detentPassed = useRef(false);

  const close = () => {
    setOffset(0);
    if (closeOpenRow === close) closeOpenRow = null;
  };

  // Close on unmount so a filtered-out row cannot leave a dangling closer
  // that reaches into a component that no longer exists.
  useEffect(() => {
    return () => {
      if (closeOpenRow === close) closeOpenRow = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!enabled) return <>{children}</>;

  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    startX.current = touch.clientX;
    startY.current = touch.clientY;
    startOffset.current = offset;
    axis.current = 'undecided';
    detentPassed.current = offset >= OPEN_THRESHOLD;
    // Another row is open and this is a different one: close it, and let
    // this touch be the dismissal rather than the start of a new swipe.
    if (closeOpenRow && closeOpenRow !== close) {
      closeOpenRow();
      closeOpenRow = null;
    }
  };

  const onTouchMove = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    const dx = touch.clientX - startX.current;
    const dy = touch.clientY - startY.current;

    if (axis.current === 'undecided') {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      // Vertical wins ties. A list is scrolled far more often than its rows
      // are deleted, so an ambiguous gesture should scroll.
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis.current === 'x') setDragging(true);
    }
    if (axis.current !== 'x') return;

    // Left is positive here: the row translates by -offset.
    let next = startOffset.current - dx;
    if (next < 0) next = 0;
    if (next > ACTION_WIDTH) {
      next = ACTION_WIDTH + (next - ACTION_WIDTH) * RUBBER;
    }

    // One tick as the action becomes committed-on-release, and one on the
    // way back. Continuous haptics during a drag are nausea, not feedback.
    const past = next >= OPEN_THRESHOLD;
    if (past !== detentPassed.current) {
      detentPassed.current = past;
      haptic('select');
    }

    setOffset(next);
  };

  const onTouchEnd = () => {
    setDragging(false);
    if (axis.current !== 'x') return;
    if (offset >= OPEN_THRESHOLD) {
      setOffset(ACTION_WIDTH);
      closeOpenRow = close;
    } else {
      close();
    }
    axis.current = 'undecided';
  };

  const open = offset > 0;

  return (
    <div className={`swipe-row ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="swipe-action"
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        aria-label={label}
        onClick={() => {
          close();
          void onDelete();
        }}
      >
        {icon}
        <span className="swipe-action-label">{label}</span>
      </button>

      <div
        className="swipe-surface"
        style={{
          transform: `translate3d(${-offset}px, 0, 0)`,
          // No transition while the finger is down -- the row must track
          // the thumb exactly. The spring only runs on the snap.
          transition: dragging
            ? 'none'
            : 'transform 0.34s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        // A tap anywhere on an open row closes it instead of opening the
        // chat, which is what every list with this gesture does.
        onClickCapture={(event) => {
          if (!open) return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        {children}
      </div>
    </div>
  );
}
