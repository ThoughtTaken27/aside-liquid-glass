import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, X } from './Icons';
import { haptic } from '../telegram';
import { useBackStack } from '../utils/backStack';

export const SHEET_MOTION_MS = 380;

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
  className = '',
  showClose = false,
  title,
  subtitle,
  onBack,
  backLabel,
  onClose,
  pageKey,
  depth = 0,
  onBackToRoot,
  children,
}: {
  side: 'bottom' | 'right';
  className?: string;
  /** Explicit exit and focus containment for touch-accessible task sheets. */
  showClose?: boolean;
  /**
   * Which page of a multi-page sheet is showing. When it changes the sheet
   * navigates instead of swapping: a deeper page pushes in from the right
   * while the old one recedes left, a shallower one does the reverse, and
   * the card's height glides between the two.
   */
  pageKey?: string;
  /** Nesting level of `pageKey`; decides push vs pop. */
  depth?: number;
  onBackToRoot?: () => void;
  title: string;
  subtitle?: string;
  /** Renders a back arrow at the head's left edge and calls this on tap. */
  onBack?: () => void;
  backLabel?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  /*
   * Leave, then unmount. Unmounting at once made every dismissal a blink,
   * and a drag past the threshold snapped the card back to the top for a
   * frame before it vanished. The card now keeps going from wherever the
   * finger let go, and the dim fades with it.
   */
  const [leaving, setLeaving] = useState(false);
  const leftRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const closeFrom = useRef('none');
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const close = () => {
    if (leftRef.current) return;
    leftRef.current = true;
    haptic('soft');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      onClose();
      return;
    }
    closeFrom.current = panel.current ? getComputedStyle(panel.current).transform : 'none';
    setLeaving(true);
    closeTimer.current = window.setTimeout(onClose, SHEET_MOTION_MS);
  };

  useBackStack(leaving ? [] : [
    { key: 'sheet', back: close },
    ...Array.from({ length: depth }, (_, index) => ({ key: 'page-' + index, back: () => index === 0 && onBackToRoot ? onBackToRoot() : onBack ? onBack() : close() })),
  ], 100);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if (onBack) onBack(); else close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, onBack]);

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
  const [direct, setDirect] = useState(false);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!showClose) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, textarea, a[href], [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
    focusables()[0]?.focus({ preventScroll: true });
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables(); const first = items[0]; const last = items[items.length - 1];
      if (!first) return;
      if (e.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', trap);
    return () => { window.removeEventListener('keydown', trap); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [showClose]);
  const drag = useRef<{ id: number; y0: number; t0: number; offset: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    if (side !== 'bottom' || leftRef.current) return;
    // Ignore secondary buttons and any press that began on a real control.
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, a, input, textarea, select')) return;
    drag.current = {
      id: event.pointerId,
      y0: event.clientY,
      t0: performance.now(),
      offset: 0,
    };
    // Capture the current entrance position before removing its animation.
    // A drag must not wait for, or snap to the end of, the entrance.
    if (panel.current) {
      const matrix = getComputedStyle(panel.current).transform;
      const translate = /^matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^,)]+)/.exec(matrix);
      const startY = translate ? Number(translate[1]) : 0;
      if (Number.isFinite(startY) && startY > 0) {
        drag.current.offset = startY;
        setDy(startY);
      }
    }
    setDirect(true);
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
    /* Downward 1:1. Upward it resists progressively (apple-design §9),
       so the card answers the finger instead of feeling frozen, but can
       never travel far enough to show a strip under it. */
    const raw = event.clientY - drag.current.y0 + drag.current.offset;
    setDy(raw >= 0 ? raw : -((-raw * 60 * 0.55) / (60 + 0.55 * -raw)));
  };

  const endDrag = (event: { pointerId: number; clientY: number }) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    const travelled = Math.max(0, event.clientY - drag.current.y0);
    const elapsed = Math.max(performance.now() - drag.current.t0, 1);
    drag.current = null;
    setDragging(false);
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
    } else {
      setDy(0);
    }
  };

  const cancelDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    setDy(0);
  };

  useEffect(() => {
    if (!dragging) return;
    // Fallback when capture is unavailable: a release outside the head
    // must still finish the gesture, and cancellation never dismisses.
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', cancelDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', cancelDrag);
    };
  }, [dragging]);

  /*
   * Page navigation inside one card (see `pageKey`).
   *
   * The outgoing page is kept as a snapshot of its React children for one
   * transition so it can leave on the same curve the new page arrives on.
   * Derived during render, the documented way to adjust state when a prop
   * changes, so the old and new pages are first painted together.
   */
  const [shown, setShown] = useState({ key: pageKey, depth });
  const [outgoing, setOutgoing] = useState<{ key: string; node: ReactNode; dir: number } | null>(null);
  const lastChildren = useRef<ReactNode>(children);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastHeight = useRef(0);
  const [dir, setDir] = useState(0);
  const heightAnimation = useRef<Animation | null>(null);
  if (pageKey !== shown.key) {
    const d = Math.sign(depth - shown.depth);
    setShown({ key: pageKey, depth });
    setDir(d);
    setOutgoing({ key: `out-${shown.key ?? ''}-${Date.now()}`, node: lastChildren.current, dir: d });
  }
  useEffect(() => {
    lastChildren.current = children;
  });
  // `animationend` never fires under reduced motion (animations are off
  // globally), so the snapshot is also retired on a clock just past the
  // longest page transition.
  useEffect(() => {
    if (!outgoing) return undefined;
    const t = window.setTimeout(() => setOutgoing(null), 450);
    return () => window.clearTimeout(t);
  }, [outgoing]);

  /*
   * Height: measured after every commit, animated only across a page
   * change. Web Animations rather than a CSS transition on `height`,
   * because the sheet is content-sized (`height: auto` cannot transition)
   * and a drag must never inherit an eased height.
   */
  const measuredKey = useRef(pageKey);
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    // The outgoing page is absolutely positioned, so this is the new
    // page's own height.
    const fromRendered = el.getBoundingClientRect().height;
    const changed = measuredKey.current !== shown.key;
    if (changed) heightAnimation.current?.cancel();
    const to = el.offsetHeight;
    const from = lastHeight.current;
    lastHeight.current = to;
    measuredKey.current = shown.key;
    if (!changed || !from || Math.abs(from - to) < 2 || typeof el.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    heightAnimation.current = el.animate([{ height: `${heightAnimation.current ? fromRendered : from}px` }, { height: `${to}px` }], {
      duration: 320,
      easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
    });
  });

  useEffect(() => () => heightAnimation.current?.cancel(), []);

  useLayoutEffect(() => {
    if (!leaving || !panel.current || typeof panel.current.animate !== 'function') return;
    const el = panel.current;
    const animation = el.animate([
      { transform: closeFrom.current },
      { transform: side === 'bottom' ? 'translate3d(0, calc(100% + 16px), 0)' : 'translate3d(calc(100% + 16px), 0, 0)' },
    ], { duration: SHEET_MOTION_MS, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
    return () => animation.cancel();
  }, [leaving, side]);

  // The dim thins as the card goes down, so the drag reads as physical.
  const height = panel.current?.offsetHeight || 600;
  const dim = leaving ? 0 : dy > 0 ? Math.max(0, 1 - dy / height) : undefined;
  const sheetStyle = leaving
    ? { transform: side === 'bottom' ? 'translate3d(0, calc(100% + 16px), 0)' : 'translate3d(calc(100% + 16px), 0, 0)' }
    : dy
      ? { transform: `translate3d(0, ${dy}px, 0)` }
      : undefined;

  const isBottom = side === 'bottom';

  return (
    <div className="sheet-layer" data-surface="sheet-layer">
      <div
        className={`sheet-backdrop${leaving ? ' is-leaving' : ''}`}
        data-surface="backdrop"
        onClick={close}
        style={dim === undefined ? undefined : { opacity: dim }}
      />
      <section
        ref={panel}
        className={`sheet surface-sheet sheet-${side} ${className}${dragging ? ' is-dragging' : ''}${leaving ? ' is-leaving' : ''}`}
        data-direct={direct ? 'true' : undefined}
        data-surface="sheet"
        data-surface-side={side}
        role="dialog"
        aria-modal="true"
        inert={leaving || undefined}
        aria-label={title}
        style={sheetStyle}
      >
        <header
          className="sheet-head surface-header"
          data-surface-header
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={cancelDrag}
          onLostPointerCapture={cancelDrag}
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
                <ChevronLeft size={21} strokeWidth={1.9} />
              </button>
            ) : null}

            <div className="sheet-titles" key={shown.key ?? 'title'} data-page-dir={outgoing ? dir : undefined}>
              <span className="sheet-title">{title}</span>
              {subtitle ? (
                <span className="sheet-subtitle">{subtitle}</span>
              ) : null}
            </div>

            {isBottom && !showClose ? null : (
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
        <div className="sheet-body surface-content" data-surface-content ref={bodyRef}>
          {pageKey === undefined ? (
            children
          ) : (
            <>
              <div
                className="sheet-page"
                key={shown.key}
                data-page-dir={outgoing ? dir : undefined}
              >
                {children}
              </div>
              {outgoing ? (
                <div
                  className="sheet-page is-leaving"
                  key={outgoing.key}
                  data-page-dir={outgoing.dir}
                  aria-hidden
                  inert
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget) setOutgoing(null);
                  }}
                >
                  {outgoing.node}
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
