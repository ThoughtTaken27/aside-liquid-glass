/**
 * The small action row under a message.
 *
 * Claude puts one under every assistant turn -- copy, share, read aloud,
 * the two ratings, retry. This is deliberately NOT all six. Share and read
 * aloud have no meaning here, and the two ratings have nowhere to send a
 * rating to; shipping a thumbs-up that writes to nothing is worse than not
 * shipping it, because it teaches the user that the row is decorative and
 * they stop looking at it.
 *
 * So: copy, and copy only, until something else earns a slot.
 *
 * Placement follows the speaker. An assistant answer is page content, so
 * its row sits flush left under the text. A user bubble is right-aligned,
 * so its row is too -- the actions stay attached to the thing they act on
 * rather than drifting to a fixed edge.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, CopyIcon } from './Icons';
import { haptic } from '../telegram';
import { copyText } from '../utils/clipboard';

export interface MessageActionsProps {
  /** The exact text to put on the clipboard -- markdown source, not HTML. */
  text: string;
  /** Which side to hang the row on. */
  align?: 'start' | 'end';
}

export function MessageActions({ text, align = 'start' }: MessageActionsProps) {
  /**
   * `idle` -> `done` -> `idle`, or `idle` -> `failed` -> `idle`.
   *
   * `failed` exists because `copyText` can genuinely fail in a webview and
   * the button must not claim success it did not have. It is the whole
   * reason this is a three-state machine rather than a boolean.
   */
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);

  // A component can unmount while the reset is pending -- the thread is
  // virtualized, so scrolling away destroys the row -- and a setState on a
  // dead component is a warning today and a leak in aggregate.
  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    // Awaited inside the click handler, not deferred, so the clipboard
    // write still counts as happening during the user gesture.
    const ok = await copyText(text);
    haptic(ok ? 'light' : 'error');
    setState(ok ? 'done' : 'failed');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1600);
  };

  if (!text.trim()) return null;

  return (
    <div className={`message-actions is-${align}`}>
      <button
        type="button"
        className={`message-action ${state === 'done' ? 'is-done' : ''}`}
        onClick={() => void copy()}
        aria-label={state === 'done' ? 'Copied' : 'Copy'}
      >
        {state === 'done' ? (
          <Check size={14} strokeWidth={2} />
        ) : (
          <CopyIcon size={14} strokeWidth={1.75} />
        )}
        <span className="message-action-label">
          {state === 'done' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
        </span>
      </button>
    </div>
  );
}
