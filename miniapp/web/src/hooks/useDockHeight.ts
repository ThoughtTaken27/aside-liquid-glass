/**
 * Publish the docked composer's height as a CSS variable.
 *
 * The composer used to be a flex SIBLING of the scroller, which meant the
 * conversation ended exactly where the composer began and nothing ever
 * passed underneath it. That is why the dissolve had nothing to dissolve:
 * a blur over a strip of empty page is just a slightly different shade of
 * empty page. Claude's composer floats ON the transcript, with text
 * visibly continuing under its top edge, and that overlap is the entire
 * reason the effect reads as depth.
 *
 * So the scroller now extends underneath the dock (a negative bottom
 * margin) and pads its content by the same amount (so the last message
 * can still be scrolled clear of it). Both numbers have to be the dock's
 * REAL height, and that height changes constantly: the textarea grows with
 * the draft, the task list appears above it, a blocked-session banner
 * pushes it taller.
 *
 * Hence a ResizeObserver rather than a constant. A hardcoded 96px is right
 * exactly once, at rest, in one language, on one phone -- and wrong every
 * time the composer grows, in the direction that hides the last line of
 * the answer behind it.
 *
 * Writes to the HOST element rather than `:root` so two docks (thread and
 * home) cannot fight over one global value.
 */
import { useLayoutEffect, type RefObject } from 'react';

export function useDockHeight(
  host: RefObject<HTMLElement | null>,
  dock: RefObject<HTMLElement | null>,
  activationKey?: unknown,
): void {
  useLayoutEffect(() => {
    const hostEl = host.current;
    const dockEl = dock.current;
    if (!hostEl || !dockEl) return undefined;

    const publish = () => {
      // `getBoundingClientRect` rather than `offsetHeight`: the dock's
      // height is frequently fractional once safe-area insets are in the
      // padding, and rounding it down leaves a 1px band of un-scrimmed
      // page under the composer.
      const height = dockEl.getBoundingClientRect().height;
      hostEl.style.setProperty('--dock-h', `${height}px`);
    };

    publish();

    // Guarded: jsdom has no ResizeObserver, and the tests that mount this
    // are asserting behaviour that does not depend on it.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(publish);
    observer.observe(dockEl);
    return () => observer.disconnect();
  }, [host, dock, activationKey]);
}
