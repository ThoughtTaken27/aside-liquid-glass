/**
 * The main thread's side of syntax highlighting.
 *
 * Code blocks ask for HTML and render plain text until it arrives; the
 * work happens in `highlight.worker.ts`, so a grammar compiling never
 * stalls a frame. Results are cached by (theme, language, code), so a
 * block that re-renders -- a theme flip back, a remount when scrolling
 * the virtualized list -- gets its colours synchronously the second time.
 *
 * Where there is no Worker (tests, very old WebViews) it falls back to
 * the in-thread loader, which is exactly how it worked before.
 */
import {
  highlightToHtml as highlightHere,
  languageIsReady,
  normalizeLang,
  onHighlighterReady,
  warmHighlighter as warmHere,
} from './highlighter';

const CACHE_LIMIT = 240;
const cache = new Map<string, string | null>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let worker: Worker | null | undefined;
let nextId = 1;
const waiting = new Map<number, string>();

const keyOf = (code: string, lang: string, dark: boolean) => `${dark ? 'd' : 'l'}\u0000${lang}\u0000${code}`;

function remember(key: string, html: string | null): void {
  cache.delete(key);
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  inflight.delete(key);
  for (const listener of listeners) listener();
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === 'undefined' || import.meta.env?.MODE === 'test') return worker;
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; html: string | null }>) => {
      const key = waiting.get(event.data.id);
      waiting.delete(event.data.id);
      if (key !== undefined) remember(key, event.data.html);
    };
    worker.onerror = () => {
      // A worker that cannot start leaves every block on plain text, which
      // is a correct rendering; fall back to the in-thread path from now on.
      worker?.terminate();
      worker = null;
      for (const key of waiting.values()) inflight.delete(key);
      waiting.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Highlighted HTML if it is already known, else null (render plain). */
export function cachedHighlight(code: string, lang: string, dark: boolean): string | null {
  const key = keyOf(code, lang, dark);
  if (cache.has(key)) return cache.get(key) ?? null;
  // In-thread fallback: answer synchronously once the grammar is there.
  if (!getWorker() && languageIsReady(lang)) {
    const html = highlightHere(code, lang, dark);
    cache.set(key, html);
    return html;
  }
  return null;
}

/** Ask for this block's colours; listeners hear when they land. */
export function requestHighlight(code: string, lang: string, dark: boolean): void {
  if (!normalizeLang(lang)) return;
  const key = keyOf(code, lang, dark);
  if (cache.has(key) || inflight.has(key)) return;
  const w = getWorker();
  if (!w) {
    warmHere([lang]);
    return;
  }
  inflight.add(key);
  const id = nextId++;
  waiting.set(id, key);
  w.postMessage({ id, code, lang, dark });
}

/** Start compiling grammars a message contains, before its blocks ask. */
export function warmLanguages(langs: readonly string[]): void {
  const wanted = langs.filter((lang) => normalizeLang(lang));
  if (!wanted.length) return;
  const w = getWorker();
  if (w) w.postMessage({ warm: wanted });
  else warmHere(wanted);
}

/** Re-render when any highlight result (or an in-thread grammar) lands. */
export function onHighlight(listener: () => void): () => void {
  listeners.add(listener);
  const off = onHighlighterReady(listener);
  return () => {
    listeners.delete(listener);
    off();
  };
}
