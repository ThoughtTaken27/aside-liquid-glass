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
import { useEffect, useState } from 'react';
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

function dismiss(id: number): void {
  const found = toasts.find((t) => t.id === id);
  if (!found || found.leaving) return;
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
  const duration = options.duration ?? (options.action ? 5 : 3.6);
  const entry: Toast = {
    id: nextId++,
    message,
    action: options.action,
    duration,
    tone: options.tone ?? 'info',
    leaving: false,
  };
  toasts = [...toasts.slice(-(MAX_VISIBLE - 1)), entry];
  emit();
  window.setTimeout(() => dismiss(entry.id), duration * 1000);
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
        <div
          key={item.id}
          className={`toast is-${item.tone}${item.leaving ? ' is-leaving' : ''}`}
          role="button"
          tabIndex={0}
          aria-label={`Dismiss: ${item.message}`}
          onClick={() => dismiss(item.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              dismiss(item.id);
            }
          }}
        >
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
        </div>
      ))}
    </div>
  );
}
