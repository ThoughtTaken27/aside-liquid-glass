/**
 * Full-screen image viewer with real pinch-zoom.
 *
 * Tapping an image in an answer used to do nothing, so a screenshot the
 * agent produced was only ever visible at thread width -- which on a phone
 * is far too small to read a screenshot of anything.
 *
 * The zoom has to be implemented rather than delegated. The app's viewport
 * meta carries `maximum-scale=1` (it has to: without it, focusing the
 * composer zooms the whole page on iOS and never zooms back), and that
 * kills the browser's own pinch gesture along with it. `touch-action:
 * pinch-zoom` does not bring it back inside a page pinned that way. So
 * this tracks pointers directly.
 *
 * Gestures, all of which behave the way the OS photo viewers behave:
 *
 *  - two fingers: scale about the midpoint, and pan with it;
 *  - one finger while zoomed in: pan, bounded to the image's own edges;
 *  - one finger at rest: drag down to dismiss, with the backdrop fading
 *    as it goes, so a half-committed gesture shows what it will do;
 *  - double tap: toggle between fit and 2.5x, centred on the tap;
 *  - tap: close.
 *
 * Pointer Events rather than Touch Events so the same code path serves a
 * trackpad and a stylus, and so `setPointerCapture` keeps a drag alive when
 * a finger leaves the element.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from './Icons';
import { haptic } from '../telegram';

/** The event any image in the app raises to ask for this viewer. */
export const IMAGE_EVENT = 'aside:open-image';

export interface ImageRequest {
  src: string;
  alt?: string;
  /** Releases a caller-owned blob URL after the viewer stops using it. */
  onClose?: () => void;
}

/** Raise the viewer from anywhere, with no prop drilling through markdown. */
export function openImage(request: ImageRequest): void {
  window.dispatchEvent(new CustomEvent(IMAGE_EVENT, { detail: request }));
}

const MAX_SCALE = 6;
const MIN_SCALE = 1;
/** Double-tap target. Enough to read a phone screenshot's body text. */
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
/** How far a one-finger drag must travel before it dismisses. */
const DISMISS_PX = 110;

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

/**
 * Keep the image from being dragged off screen.
 *
 * At 1x there is nothing to pan, so the offset is pinned to zero and the
 * one-finger gesture is free to mean "dismiss" instead.
 */
function clamp(next: Transform, box: { width: number; height: number }): Transform {
  if (next.scale <= 1) return { scale: next.scale, x: 0, y: 0 };
  const maxX = (box.width * (next.scale - 1)) / 2;
  const maxY = (box.height * (next.scale - 1)) / 2;
  return {
    scale: next.scale,
    x: Math.min(maxX, Math.max(-maxX, next.x)),
    y: Math.min(maxY, Math.max(-maxY, next.y)),
  };
}

export function ImageLightbox() {
  const [request, setRequest] = useState<ImageRequest | null>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  /** Vertical offset of an in-progress drag-to-dismiss. */
  const [dismiss, setDismiss] = useState(0);
  const [animated, setAnimated] = useState(false);

  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** Pinch state, captured when the second finger lands. */
  const pinch = useRef<{ distance: number; scale: number; x: number; y: number } | null>(
    null,
  );
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const lastTap = useRef(0);
  const moved = useRef(0);
  const release = useRef<(() => void) | null>(null);

  const close = useCallback(() => {
    release.current?.();
    release.current = null;
    setRequest(null);
    setTransform(IDENTITY);
    setDismiss(0);
    pointers.current.clear();
    pinch.current = null;
    pan.current = null;
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<ImageRequest>).detail;
      if (!detail?.src) return;
      setTransform(IDENTITY);
      setDismiss(0);
      // Opening a second image releases the first just like an explicit close.
      release.current?.();
      release.current = detail.onClose ?? null;
      setAnimated(false);
      setRequest(detail);
      haptic('light');
    };
    window.addEventListener(IMAGE_EVENT, onOpen);
    return () => {
      window.removeEventListener(IMAGE_EVENT, onOpen);
      release.current?.();
      release.current = null;
    };
  }, []);

  // Escape closes, and the page behind must not scroll while this is up.
  useEffect(() => {
    if (!request) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [request, close]);

  if (!request) return null;

  const box = () => {
    const rect = stage.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  };

  const onPointerDown = (event: React.PointerEvent) => {
    (event.target as Element).setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    setAnimated(false);
    moved.current = 0;

    const points = [...pointers.current.values()];
    if (points.length === 2) {
      // A second finger cancels whatever the first one was doing.
      pan.current = null;
      const dx = points[0].x - points[1].x;
      const dy = points[0].y - points[1].y;
      pinch.current = {
        distance: Math.hypot(dx, dy) || 1,
        scale: transform.scale,
        x: transform.x,
        y: transform.y,
      };
      return;
    }
    if (points.length === 1) {
      pan.current = {
        x: event.clientX,
        y: event.clientY,
        tx: transform.x,
        ty: transform.y,
      };
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];

    if (points.length >= 2 && pinch.current) {
      const dx = points[0].x - points[1].x;
      const dy = points[0].y - points[1].y;
      const distance = Math.hypot(dx, dy) || 1;
      const ratio = distance / pinch.current.distance;
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, pinch.current.scale * ratio),
      );
      // Scaling about the midpoint rather than the centre is what makes a
      // pinch feel like it is moving the paper under the fingers.
      const growth = scale / pinch.current.scale;
      setTransform(
        clamp(
          {
            scale,
            x: pinch.current.x * growth,
            y: pinch.current.y * growth,
          },
          box(),
        ),
      );
      moved.current = 999;
      return;
    }

    if (points.length === 1 && pan.current) {
      const dx = event.clientX - pan.current.x;
      const dy = event.clientY - pan.current.y;
      moved.current = Math.max(moved.current, Math.hypot(dx, dy));
      if (transform.scale > 1) {
        setTransform(
          clamp(
            { scale: transform.scale, x: pan.current.tx + dx, y: pan.current.ty + dy },
            box(),
          ),
        );
      } else if (dy > 0) {
        // Only downward, and only at rest: an upward drag at 1x has no
        // meaning here and should not move anything.
        setDismiss(dy);
      }
    }
  };

  const finishGesture = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) {
      pan.current = null;
      if (dismiss > DISMISS_PX) {
        haptic('light');
        close();
        return;
      }
      if (dismiss > 0) {
        setAnimated(true);
        setDismiss(0);
      }
      if (transform.scale < 1.02 && transform.scale !== 1) {
        setAnimated(true);
        setTransform(IDENTITY);
      }
    }
  };

  const onStageClick = (event: React.MouseEvent) => {
    // A pan or a pinch is not a tap, however it ends.
    if (moved.current > 8) return;
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      setAnimated(true);
      if (transform.scale > 1) {
        setTransform(IDENTITY);
      } else {
        const rect = stage.current?.getBoundingClientRect();
        // Zoom toward the point that was tapped, so the detail someone
        // aimed at is the detail that ends up under their finger.
        const offsetX = rect ? rect.left + rect.width / 2 - event.clientX : 0;
        const offsetY = rect ? rect.top + rect.height / 2 - event.clientY : 0;
        setTransform(
          clamp(
            {
              scale: DOUBLE_TAP_SCALE,
              x: offsetX * (DOUBLE_TAP_SCALE - 1),
              y: offsetY * (DOUBLE_TAP_SCALE - 1),
            },
            box(),
          ),
        );
      }
      haptic('light');
      return;
    }
    lastTap.current = now;
    // A single tap closes, but only after the double-tap window has passed
    // without a second one.
    window.setTimeout(() => {
      if (lastTap.current !== now) return;
      lastTap.current = 0;
      close();
    }, DOUBLE_TAP_MS);
  };

  const progress = Math.min(1, dismiss / (DISMISS_PX * 2));

  return createPortal(
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={request.alt || 'Image'}
      style={{ opacity: 1 - progress * 0.85 }}
    >
      <button
        type="button"
        className="lightbox-close"
        aria-label="Close image"
        onClick={close}
      >
        <X size={18} />
      </button>
      <div
        ref={stage}
        className="lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onClick={onStageClick}
      >
        <img
          className="lightbox-image"
          src={request.src}
          alt={request.alt || ''}
          draggable={false}
          style={{
            transform: `translate3d(${transform.x}px, ${transform.y + dismiss}px, 0) scale(${transform.scale})`,
            transition: animated ? 'transform 0.22s var(--ease-out)' : 'none',
          }}
          onTransitionEnd={() => setAnimated(false)}
        />
      </div>
    </div>,
    document.body,
  );
}
