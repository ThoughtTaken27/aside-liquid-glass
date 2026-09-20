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
  const close = () => {
    haptic('soft');
    onClose();
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
     * Downward only.
     *
     * Letting the sheet follow a finger UP would lift it off the bottom of
     * the screen and expose a strip of backdrop underneath, which no sheet
     * on any platform does. Clamping at zero keeps it seated.
     */
    setDy(Math.max(0, event.clientY - drag.current.y0));
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
      close();
    }
  };

  const isBottom = side === 'bottom';

  return (
    <div className="sheet-layer" data-surface="sheet-layer">
      <div className="sheet-backdrop" data-surface="backdrop" onClick={close} />
      <section
        className={`sheet surface-sheet sheet-${side}${dragging ? ' is-dragging' : ''}`}
        data-surface="sheet"
        data-surface-side={side}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={dy ? { transform: `translate3d(0, ${dy}px, 0)` } : undefined}
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
                onClick={close}
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
