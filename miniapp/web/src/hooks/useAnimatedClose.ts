import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
export const OVERLAY_MS = 320;
/** Retain an overlay until its reverse motion finishes. Re-entry cancels
 * the stale close, so opening another image cannot be closed by its timer. */
export function useAnimatedClose(onClose: () => void, element?: RefObject<HTMLElement | null>) {
  const [leaving, setLeaving] = useState(false);
  const closing = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(onClose); latest.current = onClose;
  const root = useRef(element); root.current = element;
  const reset = useCallback(() => { window.clearTimeout(timer.current); closing.current=false; setLeaving(false); }, []);
  useEffect(()=>()=>window.clearTimeout(timer.current),[]);
  const close = useCallback(()=>{
    if (closing.current) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { latest.current(); return; }
    const el = root.current?.current;
    if (el) el.style.setProperty('--motion-close-opacity', getComputedStyle(el).opacity);
    closing.current=true; setLeaving(true);
    timer.current=window.setTimeout(()=>{closing.current=false;latest.current()},OVERLAY_MS);
  },[]);
  return {leaving,close,reset};
}
