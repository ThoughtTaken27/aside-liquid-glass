import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/** Keep caret scrolling local to the field; never pan the page to find it. */
export function useComposerSizing(textarea: RefObject<HTMLTextAreaElement | null>, value: string): void {
  const mirror = useRef<HTMLDivElement | null>(null);
  const revealCaret = useCallback(() => {
    const el = textarea.current;
    if (!el || document.activeElement !== el) return;
    if (el.scrollHeight <= el.clientHeight + 1) { el.scrollTop = 0; return; }
    const at = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd;
    if (at === el.value.length) { el.scrollTop = el.scrollHeight; return; }
    // The expensive measurement is only needed when editing in the middle
    // of an overflowing draft, not on every keystroke at its end.
    if (!mirror.current) {
      mirror.current = document.createElement('div');
      mirror.current.setAttribute('aria-hidden', 'true');
      mirror.current.inert = true;
      document.body.append(mirror.current);
    }
    const box = mirror.current;
    const style = getComputedStyle(el);
    box.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;';
    for (const property of ['font', 'line-height', 'letter-spacing', 'padding', 'text-indent', 'tab-size', 'word-break', 'direction', 'text-align']) box.style.setProperty(property, style.getPropertyValue(property));
    box.style.width = `${el.clientWidth}px`;
    box.textContent = el.value.slice(0, at ?? 0);
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    box.append(marker);
    const line = Number.parseFloat(style.lineHeight) || 24;
    const top = marker.getBoundingClientRect().top - box.getBoundingClientRect().top;
    const padding = Number.parseFloat(style.paddingBottom) || 0;
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top - padding);
    else if (top + line > el.scrollTop + el.clientHeight - padding) el.scrollTop = top + line - el.clientHeight + padding;
  }, [textarea]);

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const previousTop = el.scrollTop;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    el.scrollTop = previousTop;
    revealCaret();
  }, [textarea, value, revealCaret]);

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(revealCaret);
    observer?.observe(el);
    el.addEventListener('select', revealCaret);
    el.addEventListener('focus', revealCaret);
    return () => {
      observer?.disconnect();
      el.removeEventListener('select', revealCaret);
      el.removeEventListener('focus', revealCaret);
      mirror.current?.remove();
      mirror.current = null;
    };
  }, [textarea, revealCaret]);
}
