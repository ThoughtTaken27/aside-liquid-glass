/**
 * The app's one transient notice channel.
 *
 * Before this there was no toast system at all -- confirmations either
 * went nowhere or borrowed a dialog. The shape follows beUI's animated
 * toast stack and bencho's Notify block: small glass pills docked above
 * the composer, newest on top, auto-dismissing, tappable to dismiss, with
 * an optional action button for the cases where "Undo" or "Retry" earns
 * it.
 *
 * A module-level bus rather than context, because the call sites are
 * everywhere (socket reconnects in a hook, deletes in App, picks in
 * sheets) and threading a context value through all of them would touch
 * every intermediate component. `toast()` from anywhere; one
 * `<ToastHost/>` per top-level screen renders whatever is current.
 *
 * What does NOT go here: anything with its own inline state already
 * (copy buttons say Copied/Failed where they sit), and anything
 * genuinely blocking (those keep their dialogs). Toasts are for facts
 * the user did not ask to confirm but should still hear about.
 */
import { useEffect, useRef, useState } from 'react';
import { haptic } from '../telegram';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Seconds on screen. Defaults to 3.6; actions buy a longer default. */
  duration?: number;
  action?: ToastAction;
  tone?: 'info' | 'success' | 'error';
}

interface Toast extends Required<Pick<ToastOptions, 'tone'>> {
  id: number;
  message: string;
  action?: ToastAction;
  duration: number;
  leaving: boolean;
  /** The clock is held (finger on it, or the app is in the background). */
  paused: boolean;
}

type Listener = (toasts: Toast[]) => void;

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<Listener>();
/** At most this many on screen; the oldest drops to make room. */
const MAX_VISIBLE = 3;
/** Must match the exit animation in components.css. */
const EXIT_MS = 220;

function emit(): void {
  for (const fn of listeners) fn(toasts);
}

/*
 * Pausable clocks. A toast used to expire on a fixed setTimeout, so one
 * posted while the PWA sat in the background, or held under a finger
 * mid-swipe, could vanish before anyone read it. The clock now stops
 * whenever the page is hidden or the toast is being touched, and resumes
 * with whatever time it had left (affectUI's toaster rule: nothing
 * vanishes mid-read).
 */
interface Clock { remaining: number; startedAt: number; handle: number | null; held: boolean }
const clocks = new Map<number, Clock>();

function runClock(id: number): void {
  const c = clocks.get(id);
  if (!c || c.handle !== null || c.held || pageHidden()) return;
  c.startedAt = Date.now();
  c.handle = window.setTimeout(() => dismiss(id), Math.max(0, c.remaining));
  setPaused(id, false);
}

function stopClock(id: number): void {
  const c = clocks.get(id);
  if (!c || c.handle === null) return;
  window.clearTimeout(c.handle);
  c.handle = null;
  c.remaining -= Date.now() - c.startedAt;
  setPaused(id, true);
}

function setPaused(id: number, paused: boolean): void {
  const found = toasts.find((t) => t.id === id);
  if (!found || found.paused === paused) return;
  toasts = toasts.map((t) => (t.id === id ? { ...t, paused } : t));
  emit();
}

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Hold or release one toast's clock (a finger is on it). */
function holdToast(id: number, held: boolean): void {
  const c = clocks.get(id);
  if (!c) return;
  c.held = held;
  if (held) stopClock(id);
  else runClock(id);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    for (const id of clocks.keys()) {
      if (pageHidden()) stopClock(id);
      else runClock(id);
    }
  });
}

function dismiss(id: number): void {
  const found = toasts.find((t) => t.id === id);
  if (!found || found.leaving) return;
  const c = clocks.get(id);
  if (c?.handle != null) window.clearTimeout(c.handle);
  clocks.delete(id);
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, EXIT_MS);
}

/**
 * Show a transient notice. Safe to call from anywhere, including outside
 * React (socket callbacks); when no host is mounted the toast simply has
 * no audience and expires unheard.
 */
export function toast(message: string, options: ToastOptions = {}): void {
  // A flapping connection can report the same fact twice. Keep its one
  // existing notice still, rather than stacking/replaying identical pills.
  if (!options.action && toasts.some(t => !t.leaving && !t.action && t.message === message && t.tone === (options.tone ?? 'info'))) return;
  const duration = options.duration ?? (options.action ? 5 : 3.6);
  const entry: Toast = {
    id: nextId++,
    message,
    action: options.action,
    duration,
    tone: options.tone ?? 'info',
    leaving: false,
    paused: false,
  };
  // The oldest drops to make room; its clock goes with it.
  for (const old of toasts.slice(0, Math.max(0, toasts.length - (MAX_VISIBLE - 1)))) {
    const c = clocks.get(old.id);
    if (c?.handle != null) window.clearTimeout(c.handle);
    clocks.delete(old.id);
  }
  toasts = [...toasts.slice(-(MAX_VISIBLE - 1)), entry];
  clocks.set(entry.id, { remaining: duration * 1000, startedAt: Date.now(), handle: null, held: false });
  emit();
  runClock(entry.id);
  if (pageHidden()) setPaused(entry.id, true);
}

/** Dismiss a toast early, e.g. after its action fires. */
export function dismissToast(id: number): void {
  dismiss(id);
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>(toasts);

  useEffect(() => {
    const fn: Listener = (next) => setItems([...next]);
    listeners.add(fn);
    // A toast posted before this host mounted (cold paths race it) is
    // still current and should render.
    setItems([...toasts]);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((item) => (
        <ToastPill key={item.id} item={item} />
      ))}
    </div>
  );
}

/*
 * One toast. A tap dismisses it, as before; it can also be thrown aside.
 * The pill tracks the finger 1:1 once it has moved 6px sideways, fades as
 * it travels, and on release either flies out the way it was going (far
 * enough, or flicked) or springs back with a little overshoot.
 */
function ToastPill({ item }: { item: Toast }) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; t: number; dx: number; v: number; id: number; moved: boolean } | null>(null);
  const [thrown, setThrown] = useState(0);

  const setX = (dx: number, animate: boolean) => {
    const node = el.current;
    if (!node) return;
    node.style.transition = animate ? 'transform 460ms cubic-bezier(0.34, 1.3, 0.64, 1), opacity 260ms ease' : 'none';
    node.style.transform = dx ? `translate3d(${dx}px, 0, 0)` : '';
    node.style.opacity = dx ? String(Math.max(0.25, 1 - Math.abs(dx) / 220)) : '';
  };

  return (
    <div
      ref={el}
      className={`toast is-${item.tone}${item.leaving ? ' is-leaving' : ''}${thrown ? ' is-thrown' : ''}${item.paused ? ' is-paused' : ''}`}
      style={thrown ? { transform: `translate3d(${thrown * 130}%, 0, 0)`, opacity: 0 } : undefined}
      role="button"
      tabIndex={0}
      aria-label={`Dismiss: ${item.message}`}
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, t: event.timeStamp, dx: 0, v: 0, id: event.pointerId, moved: false };
        holdToast(item.id, true);
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d || d.id !== event.pointerId) return;
        const dx = event.clientX - d.x;
        if (!d.moved && Math.abs(dx) < 6) return;
        if (!d.moved) {
          d.moved = true;
          el.current?.setPointerCapture(event.pointerId);
        }
        const dt = Math.max(1, event.timeStamp - d.t);
        d.v = (dx - d.dx) / dt;
        d.dx = dx;
        d.t = event.timeStamp;
        setX(dx, false);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        holdToast(item.id, false);
        if (!d || !d.moved) return;
        if (Math.abs(d.dx) > 72 || Math.abs(d.v) > 0.5) {
          const dir = Math.sign(d.dx || d.v) || 1;
          haptic('light');
          setX(d.dx, false);
          requestAnimationFrame(() => setThrown(dir));
          window.setTimeout(() => dismiss(item.id), 240);
        } else {
          setX(0, true);
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        holdToast(item.id, false);
        setX(0, true);
      }}
      onClick={(event) => {
        if (el.current?.style.transform) {
          event.preventDefault();
          return;
        }
        dismiss(item.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          dismiss(item.id);
        }
      }}
    >
      {item.tone !== 'info' ? (
        <svg className="toast-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          {item.tone === 'success' ? (
            <path className="toast-stroke" d="M3.5 8.4l2.9 2.9L12.6 5" pathLength={1} />
          ) : (
            <>
              <path className="toast-stroke" d="M4.5 4.5l7 7" pathLength={1} />
              <path className="toast-stroke is-second" d="M11.5 4.5l-7 7" pathLength={1} />
            </>
          )}
        </svg>
      ) : null}
      <span className="toast-message">{item.message}</span>
      {item.action ? (
        <button
          type="button"
          className="toast-action"
          onClick={(event) => {
            event.stopPropagation();
            haptic('light');
            dismiss(item.id);
            item.action!.onClick();
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      {/* The clock as a hairline; it stops whenever the clock does. */}
      <span
        className="toast-timer"
        aria-hidden="true"
        style={{ animationDuration: `${item.duration}s` }}
      />
    </div>
  );
}
