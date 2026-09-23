import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, X } from './Icons';
import { haptic } from '../telegram';

/**
 * A modal panel that slides in from an edge, over a dimmed backdrop.
 *
 * Two edges, because Aside uses two: `bottom` for the transient sheets a
 * tap opens (a model list, a file, a set of sources), `right` for the
 * session sidebar. Both are dismissed by the backdrop and by Escape.
 *
 * The two sides get different headers on purpose, and it is not
 * inconsistency. A bottom sheet is a card you pull up and throw away, so
 * it takes the grab handle, the centred title and the drag -- and needs no
 * close button, because it has three better ways out. A right panel slides
 * from the side, cannot be flicked down, and keeps its `X`; giving it a
 * handle would promise a gesture that does not exist, which is worse than
 * the button it replaced.
 */
export function Sheet({
  side,
  title,
  subtitle,
  onBack,
  backLabel,
  onClose,
  children,
}: {
  side: 'bottom' | 'right';
  title: string;
  subtitle?: string;
  /** Renders a back arrow at the head's left edge and calls this on tap. */
  onBack?: () => void;
  backLabel?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const exitDone = useRef(false);

  const finishClose = () => {
    if (exitDone.current) return;
    exitDone.current = true;
    onClose();
  };

  /*
   * Dismissal plays the entrance in reverse instead of unmounting.
   *
   * A sheet that slides up on open but vanishes on close breaks spatial
   * consistency: the eye never learns where it went. The exit mirrors the
   * enter path per client -- Telegram sheets only travelled 72/84px in,
   * so they retreat the same distance out; standalone sheets travelled
   * their full height, so they leave the same way. A drag release is the
   * exception: the finger was already throwing the sheet down, so the
   * exit continues downward off screen (from the release point, so there
   * is no seam between the drag and the animation) rather than retreating.
   *
   * WAAPI rather than CSS classes because the start value is dynamic (the
   * drag offset) and WAAPI interpolates from it with compositor
   * performance. The safety timeout covers a backgrounded tab (WAAPI
   * pauses while hidden) and any animation that never resolves; the done
   * guard keeps every path calling `onClose` exactly once.
   */
  const close = (fromY = 0) => {
    if (leaving) return;
    haptic('soft');
    const section = sectionRef.current;
    const reduce = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (reduce || !section || typeof section.animate !== 'function') {
      finishClose();
      return;
    }
    setLeaving(true);
    const standalone =
      document.documentElement.dataset.client === 'standalone';
    const flung = side === 'bottom' && (standalone || fromY > 24);
    // `--ease-exit` in tokens.css, quoted here because WAAPI takes a
    // string: an accelerate-out curve, decisive on the way out.
    const EASE_EXIT = 'cubic-bezier(0.4, 0, 1, 1)';
    const travel =
      side === 'bottom'
        ? flung
          ? 'translate3d(0, calc(100% + 24px), 0)'
          : 'translate3d(0, 72px, 0)'
        : 'translate3d(84px, 0, 0)';
    const sheetAnim = section.animate(
      [
        {
          transform: `translate3d(0, ${side === 'bottom' ? fromY : 0}px, 0)`,
          opacity: 1,
        },
        // A full runaway travels without fading (like the standalone
        // entrance it mirrors); a retreat fades as it goes, like the
        // partial entrance it reverses.
        { transform: travel, opacity: flung ? 1 : 0 },
      ],
      { duration: flung ? 220 : 190, easing: EASE_EXIT, fill: 'forwards' },
    );
    sheetAnim.onfinish = finishClose;
    sheetAnim.oncancel = finishClose;
    backdropRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 160,
      easing: 'ease-out',
      fill: 'forwards',
    });
    window.setTimeout(finishClose, 400);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // One tap of feedback on the way in; the way out is on whichever
  // dismissal path actually fires (backdrop, drag, or Escape).
  useEffect(() => {
    haptic('soft');
  }, []);

  /*
   * Drag to dismiss.
   *
   * The handle is drawn because the reference draws one, but a handle is a
   * promise: it says this card can be thrown downward, and drawing one
   * over a sheet that cannot be dragged is the exact species of detail
   * that makes an app feel like a mock-up. So the gesture is real.
   *
   * It is armed on the HEAD only, never the body. A sheet's body scrolls,
   * and a drag that starts on a scrollable list has to guess whether the
   * user meant to pan the list or dismiss the sheet -- a guess that is
   * wrong often enough to make the list feel broken. The head is
   * unambiguous, which is most of why the handle sits up there.
   */
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; y0: number; t0: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    if (side !== 'bottom') return;
    // Ignore secondary buttons and any press that began on a real control.
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    drag.current = {
      id: event.pointerId,
      y0: event.clientY,
      t0: performance.now(),
    };
    setDragging(true);
    /*
     * Capture keeps the drag alive when the finger leaves the header,
     * which it does immediately -- the sheet moves out from under it.
     * It throws on a pointer id the browser does not consider active,
     * which is the case under synthetic events, so a failure here must
     * not take the gesture down with it.
     */
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* not capturable; the drag still tracks through the handlers */
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    /*
     * Upward meets friction, not a wall.
     *
     * This used to clamp at zero, so pressing up against a seated sheet
     * hit a hard stop that read as frozen. iOS sheets resist instead:
     * the card follows at 0.3x past the boundary, which says "there is
     * nothing more here" without going dead. Release always springs back
     * (a negative offset can never pass the dismiss thresholds below).
     */
    const raw = event.clientY - drag.current.y0;
    setDy(raw >= 0 ? raw : raw * 0.3);
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    const travelled = Math.max(0, event.clientY - drag.current.y0);
    const elapsed = Math.max(performance.now() - drag.current.t0, 1);
    drag.current = null;
    setDragging(false);
    setDy(0);
    /*
     * Distance OR speed -- but speed only past a floor.
     *
     * A short, fast flick is how people actually dismiss these, and a pure
     * distance threshold rejects it: the sheet springs back and the
     * gesture feels ignored. 0.55px/ms is about the speed of a deliberate
     * flick, well above a slow drag that stops short.
     *
     * The 24px floor is not a refinement, it is the bug this would
     * otherwise have shipped with. A tap carries a few pixels of jitter
     * over a handful of milliseconds, and 4px in 6ms is 0.67px/ms -- so
     * velocity alone reads an ordinary tap on the header as a flick and
     * throws the sheet away. Requiring real travel first means only a
     * gesture that was going somewhere can qualify on speed.
     */
    if (travelled > 96 || (travelled > 24 && travelled / elapsed > 0.55)) {
      // The release point becomes the exit's start value, so the throw
      // continues from under the finger with no seam.
      close(travelled);
    }
  };

  const isBottom = side === 'bottom';

  return (
    <div className="sheet-layer" data-surface="sheet-layer">
      <div
        className="sheet-backdrop"
        data-surface="backdrop"
        ref={backdropRef}
        onClick={() => close()}
      />
      <section
        className={`sheet surface-sheet sheet-${side}${dragging ? ' is-dragging' : ''}`}
        data-surface="sheet"
        data-surface-side={side}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sectionRef}
        style={
          // The exit animation owns the transform once it starts; the only
          // thing React still does is take the sheet out of the pointer
          // path while it leaves.
          leaving
            ? { pointerEvents: 'none' }
            : dy
              ? { transform: `translate3d(0, ${dy}px, 0)` }
              : undefined
        }
      >
        <header
          className="sheet-head surface-header"
          data-surface-header
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {isBottom ? <span className="sheet-grip" aria-hidden /> : null}

          <div className="sheet-head-row">
            {onBack ? (
              <button
                type="button"
                className="sheet-back"
                onClick={onBack}
                aria-label={backLabel ? `Back to ${backLabel}` : 'Back'}
              >
                <ArrowLeft size={19} strokeWidth={1.9} />
              </button>
            ) : null}

            <div className="sheet-titles">
              <span className="sheet-title">{title}</span>
              {subtitle ? (
                <span className="sheet-subtitle">{subtitle}</span>
              ) : null}
            </div>

            {isBottom ? null : (
              <button
                type="button"
                className="icon-button"
                // Wrapped: `close` takes a release offset, and a bare
                // handler reference would hand it the click event.
                onClick={() => close()}
                aria-label="Close"
              >
                <X size={18} strokeWidth={1.75} />
              </button>
            )}
          </div>
        </header>
        <div className="sheet-body surface-content" data-surface-content>
          {children}
        </div>
      </section>
    </div>
  );
}
