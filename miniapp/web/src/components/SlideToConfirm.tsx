/**
 * Slide to confirm, for the one action that deserves a gesture.
 *
 * bencho's "Slide to confirm" block is the reference: a track with a
 * knob, a fill that follows the thumb, and a commit threshold near the
 * far end. It exists for Full Access approval in the permission sheet --
 * the highest-stakes tap in the app, and the one place a second thought
 * is worth enforcing in the gesture itself rather than in a dialog after
 * it.
 *
 * Pointer Events cover touch, pen and mouse in one path, and
 * setPointerCapture keeps the drag bound to the knob when the finger
 * drifts off it. Keyboard users get a real slider: arrows move the knob,
 * reaching the end commits. Reduced-motion drops the snap-back glide but
 * the control still works.
 */
import { useRef, useState } from 'react';
import { ChevronRight } from './Icons';
import { haptic } from '../telegram';

/** Fraction of the track the knob must pass to commit. */
const COMMIT_AT = 0.88;

export function SlideToConfirm({
  label,
  doneLabel,
  onConfirm,
  disabled,
}: {
  /** What the slide will do, e.g. "Slide to allow full access". */
  label: string;
  /** Shown briefly after committing. Defaults to "Done". */
  doneLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(false);
  const drag = useRef<{ x0: number; width: number } | null>(null);

  const commit = () => {
    setDone(true);
    haptic('success');
    onConfirm();
  };

  const update = (clientX: number) => {
    const d = drag.current;
    if (!d || d.width <= 0) return;
    const next = Math.max(0, Math.min(1, (clientX - d.x0) / d.width));
    setProgress(next);
    if (next >= COMMIT_AT) {
      drag.current = null;
      setDragging(false);
      setProgress(1);
      commit();
    }
  };

  const end = () => {
    if (done) return;
    drag.current = null;
    setDragging(false);
    // Released short: glide home. The transition only runs when NOT
    // dragging, so the knob tracks the finger exactly mid-gesture.
    setProgress(0);
  };

  return (
    <div
      ref={track}
      className={`slide-confirm${dragging ? ' is-dragging' : ''}${done ? ' is-done' : ''}`}
      data-progress={progress.toFixed(3)}
    >
      <div
        className="slide-confirm-fill"
        aria-hidden="true"
        style={{ transform: `scaleX(${progress.toFixed(3)})` }}
      />
      <span className="slide-confirm-label" aria-hidden="true">
        {done ? (doneLabel ?? 'Done') : label}
      </span>
      <div
        role="slider"
        tabIndex={disabled || done ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-disabled={disabled}
        className="slide-confirm-knob"
        style={{ left: `calc(4px + (100% - 52px) * ${progress.toFixed(3)})` }}
        onPointerDown={(event) => {
          if (disabled || done) return;
          const el = track.current;
          if (!el) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const rect = el.getBoundingClientRect();
          // Knob travel: full width minus both insets and the knob itself,
          // matching the `left` calc in the stylesheet exactly -- any skew
          // here and the knob visibly lags or leads the finger. The grab
          // point is measured too, so pressing the middle of the knob does
          // not jump it to the finger.
          const travel = rect.width - 52;
          drag.current = {
            x0: event.clientX - progress * travel,
            width: travel,
          };
          setDragging(true);
          haptic('select');
          update(event.clientX);
        }}
        onPointerMove={(event) => {
          if (drag.current) update(event.clientX);
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(event) => {
          if (disabled || done) return;
          const step =
            event.key === 'ArrowRight' || event.key === 'ArrowUp'
              ? 0.12
              : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
                ? -0.12
                : event.key === 'End'
                  ? 1
                  : event.key === 'Home'
                    ? -1
                    : 0;
          if (!step) return;
          event.preventDefault();
          const next = Math.max(0, Math.min(1, progress + step));
          setProgress(next);
          if (next >= COMMIT_AT) commit();
        }}
      >
        <ChevronRight size={20} strokeWidth={2.25} />
      </div>
    </div>
  );
}
