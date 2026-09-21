import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..');
const css = readFileSync(path.join(web, 'src/theme/components.css'), 'utf8');
const base = readFileSync(path.join(web, 'src/theme/base.css'), 'utf8');
const tokens = readFileSync(path.join(web, 'src/theme/tokens.css'), 'utf8');
const gallery = readFileSync(path.join(web, 'src/gallery.tsx'), 'utf8');
const gframe = readFileSync(path.join(web, 'gframe.html'), 'utf8');
const app = readFileSync(path.join(web, 'src/App.tsx'), 'utf8');
const index = readFileSync(path.join(web, 'index.html'), 'utf8');
const sw = readFileSync(path.join(web, 'public/sw.js'), 'utf8');
const art = path.join(web, 'public/art/zeron-liquid-dots-v2.webp');

const standalone = css.slice(css.lastIndexOf('* Zeron standalone shell'));
const composition = css.slice(css.lastIndexOf('* Claude x Zeron standalone composition'));

function at(haystack: string, needle: string): number {
  const position = haystack.indexOf(needle);
  expect(position, `expected ${needle} in the final cascade`).toBeGreaterThanOrEqual(0);
  return position;
}

describe('Zeron standalone liquid glass correction', () => {
  it('keeps the material tokens scoped and neutral', () => {
    expect(tokens).toContain(":root[data-client='standalone'] {");
    expect(tokens).toContain('--zeron-card: rgb(247 250 250 / 0.62);');
    expect(tokens).toContain('--glass-filter-history: blur(20px) saturate(0.90) brightness(1.03);');
    expect(tokens).toContain('--glass-filter-composer: blur(20px) saturate(1.03) brightness(1.03);');
    expect(tokens).toContain('--glass-fill-composer: rgb(242 248 249 / 0.38);');
    expect(tokens).toContain('--zeron-segment-selected: rgb(255 255 255 / 0.56);');
    expect(tokens).not.toContain('zeron-cyan');
  });

  it('keeps one fixed artwork field with seamless edge fades', () => {
    const backdrop = composition.slice(at(composition, ":root[data-client='standalone'] .app-home::before,"));
    expect(backdrop).toContain('var(--zeron-atmosphere)');
    expect(backdrop).toContain('background-size: 100% 100%, 100% 100%, 100% 100%, 100% 100%, cover;');
    expect(backdrop).toContain('var(--page) 7%');
    expect(backdrop).toContain('color-mix(in srgb, var(--page) 94%, transparent) 13%');
    expect(backdrop).toContain('var(--page) 100%');
    expect(backdrop).toContain('radial-gradient(ellipse 56% 82% at -12% 48%');
    expect(backdrop).toContain('radial-gradient(ellipse 56% 82% at 112% 48%');
    expect(backdrop).not.toMatch(/^\s*filter:\s*blur/m);
  });

  it('keeps the artwork behind frosted Recents groups', () => {
    const history = composition.slice(at(composition, ":root[data-client='standalone'] .home-history {"));
    expect(history).toContain('background: transparent;');
    expect(history).toContain('.session-group,');
    expect(history).toContain('backdrop-filter: blur(26px) saturate(132%);');
    expect(history).toContain('.session-row-preview {\n  display: none;');
  });

  it('centres the greeting above the composer', () => {
    const greeting = composition.slice(at(composition, ":root[data-client='standalone'] .rest-greeting {"));
    expect(greeting).toContain('font-family: var(--font-serif);');
    expect(greeting).toContain('font-size: clamp(1.9rem, 8vw, 2.2rem);');
    expect(greeting).toContain('font-weight: 400;');
    expect(greeting).toContain('letter-spacing: -0.04em;');
    expect(greeting).toContain('text-align: center;');
    expect(composition).toContain('transform: translateY(-28px);');
    expect(gallery).toContain('<RestHero name="Alex" />');
    expect(gallery).not.toContain('AsideSymbol');
  });

  it('gives the composer optical frost instead of a grey fill', () => {
    const composer = composition.slice(at(composition, ":root[data-client='standalone'] .composer {"));
    expect(composer).toContain('radial-gradient(circle at 14% 0%');
    expect(composer).toContain('backdrop-filter: blur(30px) saturate(142%);');
    expect(composer).toContain('border: 1px solid rgb(255 255 255 / 0.56);');
    expect(composer).toContain('inset 0 1.5px 0 rgb(255 255 255 / 0.82)');
    expect(composer).not.toContain('cyan');
  });

  it('keeps the Chat/Web switch compact, aligned, and neutral', () => {
    const mode = composition.slice(at(composition, ":root[data-client='standalone'] .mode-switch {"));
    expect(mode).toContain('min-height: 40px;');
    expect(mode).toContain('padding: 3px;');
    expect(mode).toContain('--mode-switch-thumb: rgb(255 255 255 / 0.70);');
    expect(mode).toContain('--mode-switch-goo: rgb(255 255 255 / 0.18);');
    expect(mode).toContain('.mode-switch-option {');
    expect(mode).toContain('width: 56px;');
    expect(mode).toContain('.mode-switch-liquid-layer,');
    expect(mode).toContain('.mode-switch-selection {');
    expect(mode).toContain('height: 32px;');
    expect(mode).toContain(".mode-switch[data-mode='search'] :is(");
    expect(mode).toContain('transform: translate3d(56px, 0, 0);');
    expect(mode).toContain('transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1);');
    expect(mode).toContain('background: transparent;');
    expect(mode).not.toContain('cyan');
    expect(mode).not.toContain('border-bottom');
  });

  it('drives the centered composer from the home scroll phase', () => {
    expect(app).toContain('homePhaseFor');
    expect(app).toContain("data-home-phase={homePhase}");
    expect(app).toContain("dataset.homePhase = phase");
    expect(app).toContain('useDockHeight(homeShell, homeDock, homeVisible)');
    expect(app).toContain("behavior: reduceMotion ? 'auto' : 'smooth'");
    expect(standalone).toContain(".app-home[data-home-phase='hero'] .home-dock {");
    expect(standalone).toContain('transform: translateY(min(calc(var(--dock-h, 104px) - 50svh), 0px));');
    expect(composition).toContain('transition: transform 210ms cubic-bezier(0.16, 1, 0.3, 1);');
    expect(app).toContain("return scrollTop <= 2 ? 'hero' : 'history';");
    expect(standalone).toContain(".app-home[data-home-phase='history'] .home-dock,");
    expect(standalone).toContain('.home-dock:has(.composer:focus-within) {');
    expect(standalone).toContain(".app-home[data-home-phase='hero'] .home-dock::before {");
    expect(standalone).toContain('opacity: 0;');
  });

  it('keeps the lifted home composition on wide screens only', () => {
    // The lift itself is gated behind min-width -- asserted on both
    // copies, because the shell region and the composition region each
    // declare the transform and the later one wins the cascade. A narrow
    // override placed between them was tried first and changed nothing on
    // a phone screenshot, which is why the lift is gated instead of
    // overridden.
    const gatedDock =
      '@media (min-width: 641px) {\n' +
      "  :root[data-client='standalone'] .app-home[data-home-phase='hero'] .home-dock {\n" +
      '    transform: translateY(min(calc(var(--dock-h, 104px) - 50svh), 0px));\n' +
      '  }\n' +
      '}';
    expect(standalone.split(gatedDock).length - 1).toBe(2);
    // And no ungated lift survives anywhere: one straggler re-lifts
    // every narrow screen.
    expect(standalone.split(gatedDock).join('')).not.toContain(
      'transform: translateY(min(calc(var(--dock-h, 104px) - 50svh), 0px));',
    );

    // The copy nudges compose around the lifted composer, so they travel
    // with the same gate -- one gated block per declaration, no strays.
    const nudges = [
      "  :root[data-client='standalone'] .rest-hero {\n    transform: translateY(48px);",
      "  :root[data-client='standalone'] .rest-cue {\n    transform: translateY(-42px);",
      "  :root[data-client='standalone'] .rest-hero {\n    transform: translateY(-28px);",
      "  :root[data-client='standalone'] .rest-cue {\n    transform: translateY(-18px);",
    ];
    for (const nudge of nudges) {
      expect(standalone).toContain(`@media (min-width: 641px) {\n${nudge}`);
      const decl = nudge.slice(nudge.indexOf('transform:'));
      expect(standalone.split(decl).length - 1).toBe(1);
    }
  });

  it('keeps keyboard focus transparent instead of painting a grey dock', () => {
    const focusDock = standalone.slice(
      standalone.indexOf(".app-home[data-home-phase='hero'] .home-dock:focus-within::before"),
      standalone.indexOf(".app-home[data-home-phase='hero'] .home-dock:focus-within::before") + 520,
    );
    expect(focusDock).toContain('opacity: 0;');
    expect(standalone).toContain('.composer-input:focus-visible {');
    expect(standalone).toContain('background: transparent !important;');
    expect(standalone).toContain('outline: 0 !important;');
  });

  it('keeps Zeron motion exact and reduced-motion safe', () => {
    expect(tokens).toContain('--duration-fast: 140ms;');
    expect(tokens).toContain('--duration-slow: 500ms;');
    expect(base).toContain('@media (prefers-reduced-motion: reduce)');
    expect(base).toContain('transform: none !important;');
    expect(standalone).toContain('@media (prefers-reduced-motion: reduce)');
    expect(standalone).not.toMatch(/rest-bob/);
  });

  it('keeps audit hit areas at 44x44 and Telegram untouched', () => {
    for (const name of ['.jump-latest', '.lightbox-close', '.sheet-back', '.chip-remove', '.question-recover']) {
      expect(base).toContain(name);
    }
    expect(base).toContain('min-width: 44px;');
    expect(base).toContain('min-height: 44px;');
    expect(standalone).toContain('.mode-switch-option::before {');
    expect(standalone).toContain('inset: -6px 0;');
    expect(base).toContain('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))');
    expect(base).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(css).not.toMatch(/\.composer\s*:focus-within\s*\{[^}]*cyan/s);
    expect(css).not.toMatch(/0 0 0 2px[^;]*cyan/s);
  });

  it('keeps Telegram behavior isolated from the standalone handoff', () => {
    // Telegram/haptic imports and helpers stay wired; the standalone phase
    // must not fork them. The handoff only reads scrollTop and writes the
    // shell dataset inside the existing home scroll handler.
    expect(app).toContain("from './telegram'");
    expect(app).toContain('homePhaseFor');
    // Standalone CSS only documents the shared baseline in comments; it
    // adds no Telegram selectors or behavior of its own.
    expect(standalone).not.toMatch(/data-client='(telegram|web)'/);
    expect(base).not.toMatch(/data-client='(telegram|web)'/);
    expect(standalone).not.toContain('updateHomeScrimTelegram');
  });

  it('keeps fallback rules after every translucent standalone rule', () => {
    const fallback = at(standalone, '@supports not ((backdrop-filter: blur(1px))');
    const reduced = at(standalone, '@media (prefers-reduced-transparency: reduce)');
    expect(fallback).toBeGreaterThan(standalone.lastIndexOf('backdrop-filter: var(--glass-filter-composer);'));
    expect(reduced).toBeGreaterThan(standalone.lastIndexOf('backdrop-filter: var(--glass-filter-history);'));
    expect(reduced).toBeGreaterThan(fallback);
    expect(standalone.slice(fallback)).toContain('backdrop-filter: none;');
    expect(standalone.slice(reduced)).toContain('background: var(--zeron-card-strong);');
    expect(standalone.slice(reduced)).toContain('backdrop-filter: none;');
  });

  it('preserves 44x44 standalone hit areas without touching Telegram', () => {
    expect(base).toContain('.chip-remove,');
    expect(base).toContain('min-width: 44px;');
    expect(base).toContain('min-height: 44px;');
    expect(standalone).not.toMatch(/^\s*\.(?:app-home|composer|mode-switch|icon-button)\s*\{/m);
    expect(standalone).toMatch(/:root\[data-client='standalone'\]/);
    expect(base).not.toContain('zeron-cyan');
    expect(gallery).toContain("document.documentElement.dataset.client = 'standalone'");
  });

  it('keeps the gallery representative and the frame at 393x852', () => {
    expect(gallery).toContain("location.search.includes('dark')");
    expect(gallery).toContain('<ModeSwitch mode={mode} onChange={setMode}');
    expect(gallery).toContain('<Composer');
    expect(gallery).toContain('history.slice(2)');
    expect(gframe).toContain('width:393px;height:852px');
    expect(gframe).toContain('/gallery.html?home');
  });

  it('preloads a phone-sized cached artwork instead of revealing a huge JPEG late', () => {
    expect(existsSync(art)).toBe(true);
    expect(statSync(art).size).toBeGreaterThan(150_000);
    expect(statSync(art).size).toBeLessThan(250_000);
    const bytes = readFileSync(art);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(tokens).toContain("url('/art/zeron-liquid-dots-v2.webp')");
    // Standalone-only: a static <link rel=preload> fetched the 201KB webp
    // on Telegram boots that never render it. Injected from the head script
    // instead, still before first paint, only for the shell that uses it.
    expect(index).not.toContain('<link');
    expect(index).toContain("art.rel = 'preload'");
    expect(index).toContain("fetchPriority = 'high'");
    expect(index).toContain('/art/zeron-liquid-dots-v2.webp');
    expect(index).toContain("location.pathname.startsWith('/app')");
    expect(sw).toContain("url.pathname.startsWith('/art/')");
    expect(sw).toContain('cache.add(ART_URL)');
    expect(standalone).not.toContain('zeron-art-in');
  });
});
