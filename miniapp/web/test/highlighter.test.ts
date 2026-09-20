import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getReadyHighlighter,
  highlightToHtml,
  languageIsReady,
  normalizeLang,
  warmHighlighter,
} from '../src/utils/highlighter';

/** `highlightToHtml`'s third argument is a dark-mode flag, not a theme id. */
const LIGHT = false;
const DARK = true;

/**
 * The highlighter had no test at all, which is how it went unnoticed that
 * it was dragging 607.8KB of base64'd Oniguruma WASM into the bundle --
 * on its own larger than every other script the app ships combined.
 *
 * It now runs on Shiki's pure-JavaScript regex engine, which translates
 * Oniguruma patterns to native RegExp. That is a real behavioural swap,
 * not a build flag: a grammar that relied on a construct with no ES
 * equivalent would silently lose its colours, and in `forgiving` mode it
 * would do so without throwing. Exactly the kind of regression a human
 * notices six weeks later and cannot bisect.
 *
 * So these tests assert the outcome rather than the wiring: every grammar
 * the app can load must produce genuinely multi-coloured output.
 */

const LANGS = [
  'typescript',
  'javascript',
  'json',
  'bash',
  'python',
  'css',
  'html',
  'markdown',
] as const;

/** Realistic enough to exercise more than one token class per grammar. */
const SAMPLES: Record<(typeof LANGS)[number], string> = {
  typescript: 'interface A { b?: string }\nconst x: number = 1; // c',
  javascript: 'async function f() { return await g(`x${1}`); } // c',
  json: '{"a": [1, 2, {"b": null}], "c": true}',
  bash: 'for f in *.ts; do echo "${f%%.ts}"; done # c',
  python: 'def f(x: int) -> str:\n    return f"{x!r}"  # c',
  css: '.a::after { content: ""; color: var(--x); }',
  html: '<div class="a"><!-- c --><img src="x"></div>',
  markdown: '# h\n\n- [ ] a `code` **b**\n',
};

function distinctColours(html: string): number {
  return new Set(html.match(/color:#[0-9a-fA-F]{3,8}/g) ?? []).size;
}

async function ready(lang: string): Promise<void> {
  warmHighlighter([lang]);
  for (let i = 0; i < 200; i += 1) {
    if (getReadyHighlighter() && languageIsReady(lang)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`highlighter never became ready for ${lang}`);
}

describe('syntax highlighting on the JavaScript regex engine', () => {
  it.each(LANGS)('gives %s more than one colour', async (lang) => {
    await ready(lang);
    const html = highlightToHtml(SAMPLES[lang], lang, LIGHT);
    expect(html).toBeTruthy();
    // One colour means the grammar matched nothing and the whole block
    // fell back to plain foreground text -- the exact silent failure the
    // engine swap could have caused.
    expect(distinctColours(html ?? '')).toBeGreaterThan(1);
  }, 30_000);

  it('colours the dark theme too, not just the light one', async () => {
    await ready('typescript');
    const dark = highlightToHtml(SAMPLES.typescript, 'typescript', DARK);
    const light = highlightToHtml(SAMPLES.typescript, 'typescript', LIGHT);
    // Different themes, so different palettes: proves the flag is read.
    expect(dark).not.toBe(light);
    expect(distinctColours(dark ?? '')).toBeGreaterThan(1);
  }, 30_000);

  it('still resolves the fence aliases the app accepts', () => {
    expect(normalizeLang('ts')).toBe('typescript');
    expect(normalizeLang('sh')).toBe('bash');
    expect(normalizeLang('TSX')).toBe('typescript');
    expect(normalizeLang('brainfuck')).toBeNull();
  });

  /**
   * The guard that keeps the 607.8KB back out.
   *
   * A source-level assertion on purpose: importing the WASM engine
   * anywhere in this module is what re-inflates the bundle, and it would
   * do so while every behavioural test above still passed, because the
   * output is identical either way. Only the byte count changes, and
   * nothing else here can see the byte count.
   *
   * Matched against import statements rather than the raw text, because
   * the module's own comment explains what it replaced and names it. The
   * first version of this test failed on that comment, which is a fair
   * warning about assertions that cannot tell code from prose.
   */
  it('does not pull the Oniguruma WASM back into the bundle', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../src/utils/highlighter.ts'),
      'utf8',
    );
    const imports = src.match(/\bimport\s*\(\s*['"][^'"]+['"]\s*\)/g) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => /shiki\/wasm/.test(i))).toEqual([]);
    expect(imports.filter((i) => /engine\/oniguruma/.test(i))).toEqual([]);
    expect(imports.some((i) => /engine\/javascript/.test(i))).toBe(true);
  });
});
