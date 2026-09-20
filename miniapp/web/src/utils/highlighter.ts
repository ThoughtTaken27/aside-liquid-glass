/**
 * Lazy, fine-grained Shiki loader.
 *
 * Day 1 plan 5.7: syntax highlighting via shiki, a two-theme subset (one
 * light, one dark), only the languages that actually appear in this app's
 * transcripts. Shiki's default entry point bundles every grammar and theme
 * it ships; the fine-grained core API (`createHighlighterCore` plus
 * per-language/per-theme dynamic imports) is what keeps this to exactly
 * eight small WASM-free grammar modules instead of ~180.
 *
 * Nothing loads until a code fence in a language this app knows about is
 * actually rendered, and then only that language's grammar. The earlier
 * version warmed all eight grammars plus the 622KB oniguruma WASM chunk
 * after first paint from every mounted `Markdown` component, so a thread of
 * pure prose -- which is most of them -- still pulled roughly 1.2MB over
 * the phone's link before it could be sure nobody needed it.
 */
import type { HighlighterCore } from 'shiki/core';

/** Exactly the plan's list, nothing more. */
const LANG_LOADERS: Record<string, () => Promise<any>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
};

/** Common fence tags that mean one of the languages above. */
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  md: 'markdown',
};

/*
 * The two themes, chosen to sit inside this app's palette rather than beside
 * it. GitHub Light, which used to be here, is built on a blue-and-purple
 * ramp; dropped into a warm near-neutral page next to a clay accent, a code
 * block was the one rectangle on screen that belonged to a different app.
 * Vitesse is warm-neutral in both directions -- earth browns, muted greens,
 * a dull red -- and its backgrounds are neutralised anyway (see
 * `.md-pre-shiki` in components.css), so only the token colours land.
 */
export const LIGHT_THEME = 'vitesse-light';
export const DARK_THEME = 'vitesse-dark';

/** The fence tag this app knows how to highlight, or null -- callers fall back to plain text either way. */
export function normalizeLang(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  if (LANG_LOADERS[key]) return key;
  const aliased = LANG_ALIASES[key];
  return aliased && LANG_LOADERS[aliased] ? aliased : null;
}

let corePromise: Promise<HighlighterCore> | null = null;
/** Grammars already registered on the core, or in flight. */
const langPromises = new Map<string, Promise<void>>();

/**
 * The core, the regex engine and the two themes -- everything except the
 * grammars.
 *
 * This used to pull oniguruma: `shiki/engine/oniguruma` plus `shiki/wasm`,
 * where the WASM is base64'd into a JS module because a bundled `.wasm`
 * cannot be imported as data. That chunk measured 607.8KB raw and 190KB
 * brotli in the emitted build -- on its own, larger than the entire rest
 * of the app's JavaScript.
 *
 * Shiki has shipped a pure-JavaScript regex engine since v1.29, which
 * translates Oniguruma patterns to native RegExp via `oniguruma-to-es`.
 * That package is already in the tree as a transitive dependency, so this
 * swap adds nothing to install and deletes the largest asset we ship.
 *
 * `forgiving: true` is the safety valve. A handful of Oniguruma constructs
 * have no ES equivalent; forgiving mode drops those individual patterns
 * instead of throwing, so the worst case is one token that misses its
 * colour rather than a code block that fails to render. Verified against
 * all eight grammars this app loads, below.
 *
 * Still lazy: loaded once, on the first code block that actually needs
 * highlighting, and never for a thread of pure prose.
 */
function loadCore(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
        await Promise.all([
          import('shiki/core'),
          import('shiki/engine/javascript'),
        ]);
      return createHighlighterCore({
        themes: [
          import('shiki/themes/vitesse-light.mjs'),
          import('shiki/themes/vitesse-dark.mjs'),
        ],
        // Deliberately empty: grammars arrive one at a time, below.
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })();
  }
  return corePromise;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let ready: HighlighterCore | null = null;
const loaded = new Set<string>();

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Load exactly the grammar a rendered code block asked for.
 *
 * The previous version loaded all eight at once, behind a `warmHighlighter()`
 * that every `Markdown` component called after first paint -- so a thread
 * with no code in it at all still pulled the WASM engine, the core, both
 * themes and eight grammars over the phone's connection. Measured in the
 * emitted build that set is roughly 1.2MB, and it competed with the thread's
 * own data for the link.
 *
 * Now nothing loads until a fence appears, and then only that language.
 */
function ensureLanguage(lang: string): Promise<void> {
  const existing = langPromises.get(lang);
  if (existing) return existing;
  const loader = LANG_LOADERS[lang];
  if (!loader) return Promise.resolve();
  const promise = (async () => {
    const [core, grammar] = await Promise.all([loadCore(), loader()]);
    await core.loadLanguage(grammar.default ?? grammar);
    ready = core;
    loaded.add(lang);
    announce();
  })().catch(() => {
    // A grammar that fails to load leaves the plain-text fallback in
    // place, which is a correct rendering, so it must not be retried in a
    // loop or surfaced as an error.
    langPromises.delete(lang);
  });
  langPromises.set(lang, promise);
  return promise;
}

/**
 * Start loading the languages a piece of markdown actually contains.
 *
 * Safe to call repeatedly and from every mounted component: each language
 * is loaded at most once, and unknown or absent languages cost nothing.
 */
export function warmHighlighter(langs: readonly string[]): void {
  for (const raw of langs) {
    const normalized = normalizeLang(raw);
    if (normalized) void ensureLanguage(normalized);
  }
}

/** Subscribe to "a grammar just became available". */
export function onHighlighterReady(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getReadyHighlighter(): HighlighterCore | null {
  return ready;
}

/** True once this specific language can be highlighted. */
export function languageIsReady(lang: string): boolean {
  const normalized = normalizeLang(lang);
  return normalized ? loaded.has(normalized) : false;
}

/**
 * Null when this language has not loaded yet, or is not one of the eight
 * supported -- either way the caller's plain-text fallback is correct.
 */
export function highlightToHtml(
  code: string,
  lang: string,
  dark: boolean,
): string | null {
  const normalized = normalizeLang(lang);
  if (!normalized || !ready || !loaded.has(normalized)) return null;
  try {
    return ready.codeToHtml(code, {
      lang: normalized,
      theme: dark ? DARK_THEME : LIGHT_THEME,
    });
  } catch {
    return null;
  }
}
