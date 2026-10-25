/**
 * Shiki, off the main thread.
 *
 * Compiling a grammar on the JavaScript regex engine is one long task:
 * traced at 260-285ms on a desktop for TypeScript, landing exactly when a
 * code fence first appears in a streaming answer -- the moment the
 * transcript is gliding and words are fading in, so the whole screen
 * froze for a quarter second. Here it can take as long as it likes.
 */
import {
  highlightToHtml,
  languageIsReady,
  normalizeLang,
  onHighlighterReady,
  warmHighlighter,
} from './highlighter';

type Request = { id: number; code: string; lang: string; dark: boolean } | { warm: string[] };

function whenReady(lang: string): Promise<boolean> {
  if (!normalizeLang(lang)) return Promise.resolve(false);
  if (languageIsReady(lang)) return Promise.resolve(true);
  warmHighlighter([lang]);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { off(); resolve(languageIsReady(lang)); }, 15_000);
    const off = onHighlighterReady(() => {
      if (!languageIsReady(lang)) return;
      clearTimeout(timeout);
      off();
      resolve(true);
    });
  });
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const data = event.data;
  if ('warm' in data) {
    warmHighlighter(data.warm);
    return;
  }
  const ok = await whenReady(data.lang);
  const html = ok ? highlightToHtml(data.code, data.lang, data.dark) : null;
  (self as unknown as Worker).postMessage({ id: data.id, html });
};
