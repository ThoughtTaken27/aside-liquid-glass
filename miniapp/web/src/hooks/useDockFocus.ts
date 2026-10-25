import { useLayoutEffect, type RefObject } from 'react';

/** Layout follows actual element focus, not the browser window's transient :focus state. */
export function useDockFocus(dock: RefObject<HTMLElement | null>, activationKey?: unknown): void {
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el) return;
    const sync = () => el.toggleAttribute('data-composer-focused', el.contains(document.activeElement));
    const leave = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && el.contains(event.relatedTarget)) return;
      // A backgrounded window keeps its presentation; it is not a keyboard dismissal.
      if (!event.relatedTarget && !document.hasFocus()) return;
      el.removeAttribute('data-composer-focused');
    };
    sync();
    el.addEventListener('focusin', sync);
    el.addEventListener('focusout', leave);
    window.addEventListener('focus', sync);
    return () => {
      el.removeEventListener('focusin', sync);
      el.removeEventListener('focusout', leave);
      window.removeEventListener('focus', sync);
      el.removeAttribute('data-composer-focused');
    };
  }, [dock, activationKey]);
}
