import { useEffect, useRef, useState } from 'react';
export const ITEM_EXIT_MS = 354;
export interface PresenceItem<T> { key: string; item: T; present: boolean; entering: boolean; removeAt?: number }
const reduced = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** Data changes now; only its inert presentation survives the exit. */
export function usePresenceItems<T>(items: readonly T[], keyOf: (item: T) => string): PresenceItem<T>[] {
  const [rows, setRows] = useState<PresenceItem<T>[]>(() => items.map(item => ({ key: keyOf(item), item, present: true, entering: false })));
  const previous = useRef(items);
  let shown = rows;
  if (previous.current !== items) {
    previous.current = items;
    const old = new Map(rows.map(row => [row.key, row]));
    const live = new Set(items.map(keyOf));
    const instant = reduced();
    shown = items.map(item => {
      const key = keyOf(item), prior = old.get(key);
      if (prior?.present && prior.item === item) return prior;
      return { key, item, present: true, entering: prior ? false : !instant };
    });
    if (!instant) rows.forEach((row, index) => {
      if (!live.has(row.key)) shown.splice(Math.min(index, shown.length), 0, row.present ? { ...row, present: false, entering: false, removeAt: Date.now() + ITEM_EXIT_MS } : row);
    });
    if (shown.length !== rows.length || shown.some((row, i) => row !== rows[i])) setRows(shown);
  }
  useEffect(() => {
    if (!rows.some(row => row.entering && row.present)) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setRows(current => current.map(row => row.present && row.entering ? { ...row, entering: false } : row))); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [rows]);
  useEffect(() => {
    const deadlines = rows.flatMap(row => row.removeAt === undefined ? [] : [row.removeAt]);
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => setRows(current => current.filter(row => row.removeAt === undefined || row.removeAt > Date.now())), Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => clearTimeout(timer);
  }, [rows]);
  return shown;
}

/** Keeps a parent mounted until its child's presentation has folded away. */
export function useExitPresence(open: boolean): boolean {
  const [held, setHeld] = useState(open);
  useEffect(() => {
    if (open) { setHeld(true); return; }
    if (!held) return;
    if (reduced()) { setHeld(false); return; }
    const timer = window.setTimeout(() => setHeld(false), ITEM_EXIT_MS + 16);
    return () => clearTimeout(timer);
  }, [open, held]);
  return open || (held && !reduced());
}
