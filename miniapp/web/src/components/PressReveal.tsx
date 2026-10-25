/**
 * Press and hold a message to reveal its actions.
 *
 * The action row used to sit under every turn permanently, which put a
 * control under every single thing either party had ever said. On a long
 * thread that is more buttons than sentences, and it made the conversation
 * read as a list of records rather than as a conversation. Hiding it behind
 * a hold costs one gesture and buys back the whole page.
 *
 * The gesture rules, and why each one exists:
 *
 *  - **450ms.** Below ~350ms a slow tap triggers it by accident; above
 *    ~600ms it feels broken and people give up mid-press. 450 is the
 *    middle of the range every mobile OS uses for the same gesture.
 *  - **Movement cancels.** More than 10px of travel means the finger is
 *    scrolling, not holding. Without this, every slow scroll past a long
 *    answer pops actions open behind the thumb.
 *  - **Haptic on arm, not on release.** The tick fires the moment the
 *    threshold is crossed, while the finger is still down, so the hold has
 *    a felt endpoint and nobody keeps pressing to find out if it worked.
 *  - **One open at a time**, via a module-level closer rather than lifted
 *    state, so opening one row does not re-render the entire thread.
 *
 * Dismissal is any touch outside, or any scroll. Deliberately NOT a
 * timeout: a row that vanishes on its own while you are reaching for it is
 * the most annoying possible outcome, and there is no cost to leaving it
 * open until the next thing happens.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageActions } from './MessageActions';
import { haptic } from '../telegram';

/** How long the finger must stay down. */
const HOLD_MS = 450;
/** Travel that reclassifies the gesture as a scroll. */
const MOVE_CANCEL = 10;

/** The currently revealed turn's closer. See SwipeToDelete for the pattern. */
let closeOpen: (() => void) | null = null;

export interface PressRevealProps {
  /** Text the revealed action row will copy. */
  text: string;
  /** Which side to hang the row on -- follows the speaker. */
  align?: 'start' | 'end';
  /** Class for the wrapper, so the caller keeps control of turn spacing. */
  className?: string;
  /**
   * When false the gesture is not attached at all and nothing can be
   * revealed -- used for streaming and pending turns, which have no
   * settled text to copy.
   */
  enabled?: boolean;
  children: ReactNode;
}

export function PressReveal({
  text,
  align = 'start',
  className = '',
  enabled = true,
  children,
}: PressRevealProps) {
  const [open, setOpen] = useState(false);
  const holdTimer = useRef<number | undefined>(undefined);
  const start = useRef({ x: 0, y: 0 });
  const armed = useRef(false);
  const hostRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    if (closeOpen === close) closeOpen = null;
  };

  const clearHold = () => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
  };

  useEffect(() => {
    return () => {
      clearHold();
      if (closeOpen === close) closeOpen = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * While open, any touch outside or any scroll closes it.
   *
   * Capture phase on both: a touch that lands on another turn must close
   * this one BEFORE that turn's own handler runs, otherwise the two fight
   * over which is open and the second one loses.
   */
  useEffect(() => {
    if (!open) return undefined;

    const onOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && hostRef.current?.contains(target)) return;
      close();
    };
    const onScroll = () => close();

    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('touchstart', onOutside, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('touchstart', onOutside, true);
      window.removeEventListener('scroll', onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!enabled) {
    return <div className={className}>{children}</div>;
  }

  const begin = (x: number, y: number) => {
    start.current = { x, y };
    armed.current = false;
    clearHold();
    holdTimer.current = window.setTimeout(() => {
      armed.current = true;
      haptic('medium');
      // Close whatever else was open, then claim the slot.
      if (closeOpen && closeOpen !== close) closeOpen();
      closeOpen = close;
      setOpen(true);
    }, HOLD_MS);
  };

  const move = (x: number, y: number) => {
    if (holdTimer.current === undefined) return;
    const dx = Math.abs(x - start.current.x);
    const dy = Math.abs(y - start.current.y);
    if (dx > MOVE_CANCEL || dy > MOVE_CANCEL) clearHold();
  };

  return (
    <div
      ref={hostRef}
      className={`${className} press-reveal ${open ? 'is-open' : ''}`}
      onTouchStart={(event) => {
        const touch = event.touches[0];
        begin(touch.clientX, touch.clientY);
      }}
      onTouchMove={(event) => {
        const touch = event.touches[0];
        move(touch.clientX, touch.clientY);
      }}
      onTouchEnd={clearHold}
      onTouchCancel={clearHold}
      // Mouse equivalents, so the gesture is reachable on desktop Telegram
      // and in a plain browser tab rather than being phone-only.
      onMouseDown={(event) => begin(event.clientX, event.clientY)}
      onMouseMove={(event) => move(event.clientX, event.clientY)}
      onMouseUp={clearHold}
      onMouseLeave={clearHold}
      // Right-click is the desktop idiom for the same intent, and it costs
      // one line to honour it.
      onContextMenu={(event) => {
        event.preventDefault();
        if (closeOpen && closeOpen !== close) closeOpen();
        closeOpen = close;
        setOpen(true);
      }}
    >
      {children}
      {open ? <MessageActions text={text} align={align} /> : null}
    </div>
  );
}
