import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * Open on the composer, like Claude and ChatGPT: launching Aside or coming
 * back to it lands with the caret in the box. Coming back brings the
 * keyboard up too. A cold launch cannot: Chrome only raises the keyboard for
 * a page that has been touched since it loaded, so there the caret waits
 * and the first tap opens it.
 *
 * `atRest` is the screen's own judgement (Home, on its hero, nothing over
 * it). Never over a field or sheet you were already in. Re-checked when the
 * timer fires, so a notification that opens a thread on return is never
 * fought for focus.
 */
export function useRestingFocus(container: RefObject<HTMLElement | null>, atRest: boolean, enabled = true): void {
  const atRestRef = useRef(atRest);
  atRestRef.current = atRest;
  const timer = useRef(0);
  const focusSoon = useCallback(() => {
    window.clearTimeout(timer.current);
    const focus = () => {
      if (!atRestRef.current || document.visibilityState !== 'visible') return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      container.current?.querySelector<HTMLTextAreaElement>('.composer-input:not(:disabled)')?.focus({ preventScroll: true });
    };
    // The keyboard needs the window to have input focus, which can trail
    // the page becoming visible by a beat on return.
    timer.current = window.setTimeout(() => {
      if (document.hasFocus()) focus();
      else window.addEventListener('focus', focus, { once: true });
    }, 120);
  }, [container]);

  const launched = useRef(false);
  useEffect(() => {
    if (!enabled || !atRest || launched.current) return;
    launched.current = true;
    focusSoon();
  }, [enabled, atRest, focusSoon]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onVisible = () => {
      if (document.visibilityState === 'visible') focusSoon();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearTimeout(timer.current);
    };
  }, [enabled, focusSoon]);
}
