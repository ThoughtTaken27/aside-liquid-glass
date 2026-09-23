/**
 * The stylesheet actually styles the components.
 *
 * Class names are strings on both sides -- a rename in a component
 * orphans its CSS with no type error and no failing test, and the first
 * symptom is a phone rendering an unstyled control. This loads the real
 * stylesheets into jsdom and asserts the structural declarations land:
 * positions, displays, overflows, the values that decide whether a thing
 * reads as designed at all. (jsdom does not resolve var(), so token
 * values are audited separately; what matters here is that the selector
 * matches and the declaration parses.)
 */
import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

function css(className: string, parent?: Element): CSSStyleDeclaration {
  const el = document.createElement('div');
  el.className = className;
  (parent ?? document.body).appendChild(el);
  return getComputedStyle(el);
}

beforeAll(() => {
  const style = document.createElement('style');
  style.textContent =
    fs.readFileSync('src/theme/tokens.css', 'utf8') +
    fs.readFileSync('src/theme/components.css', 'utf8');
  document.head.appendChild(style);
});

describe('toast stack', () => {
  it('docks the host and click-throughs it', () => {
    const host = css('toast-host');
    expect(host.position).toBe('fixed');
    expect(host.display).toBe('flex');
    expect(host.pointerEvents).toBe('none');
  });

  it('makes the pills tappable', () => {
    const host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
    const pill = css('toast is-error', host);
    expect(pill.display).toBe('flex');
    expect(pill.pointerEvents).toBe('auto');
  });
});

describe('slide to confirm', () => {
  it('lays out track and knob', () => {
    const track = css('slide-confirm');
    expect(track.position).toBe('relative');
    expect(track.height).toBe('56px');
    const trackEl = document.createElement('div');
    trackEl.className = 'slide-confirm';
    document.body.appendChild(trackEl);
    const knob = css('slide-confirm-knob', trackEl);
    expect(knob.position).toBe('absolute');
    // Without this the drag becomes a scroll. Asserted from source:
    // jsdom's CSS parser drops touch-action as an unknown property.
    const cssText = fs.readFileSync('src/theme/components.css', 'utf8');
    const knobRule = cssText.slice(
      cssText.indexOf('.slide-confirm-knob {'),
      cssText.indexOf('.slide-confirm-knob {') + 600,
    );
    expect(knobRule).toContain('touch-action: none');
  });
});

describe('pull to refresh', () => {
  it('clips the indicator and pushes on margin', () => {
    const wrap = css('pull-refresh');
    expect(wrap.position).toBe('relative');
    expect(wrap.overflow).toBe('hidden');
    const wrapEl = document.createElement('div');
    wrapEl.className = 'pull-refresh';
    document.body.appendChild(wrapEl);
    expect(css('pull-refresh-indicator', wrapEl).position).toBe('absolute');
    expect(css('pull-refresh-content', wrapEl).transition).toContain(
      'margin-top',
    );
  });
});

describe('activity island', () => {
  it('floats above the footer', () => {
    const island = css('activity-island is-expanded');
    expect(island.position).toBe('absolute');
    expect(island.width).toBe('max-content');
  });
});

describe('states and rows', () => {
  it('composes the failure and blank states', () => {
    const error = css('thread-error');
    expect(error.display).toBe('flex');
    expect(error.flexDirection).toBe('column');
    const blank = css('history-blank');
    expect(blank.display).toBe('flex');
    expect(blank.flexDirection).toBe('column');
  });

  it('styles palette rows and the armed swipe', () => {
    expect(css('palette-row').display).toBe('flex');
    expect(css('swipe-action is-armed').filter).toBe('brightness(0.84)');
  });

  it('gives the active theme segment the house shadow', () => {
    expect(css('settings-segment is-on').boxShadow).toBe(
      '0 1px 2px oklch(14.5% 0 0 / 0.06)',
    );
  });
});

describe('answering tail and activity type', () => {
  // Keyframes, `var()` weights, and tabular figures do not survive jsdom's
  // computed styles, so these are asserted from source like touch-action.
  const cssText = fs.readFileSync('src/theme/components.css', 'utf8');

  it('settles the answering summary in with a rise-and-fade', () => {
    expect(cssText).toContain('.fold.is-answering .fold-label {');
    expect(cssText).toContain('@keyframes fold-settle {');
  });

  it('weights the live sentence above its settled siblings', () => {
    const live = cssText.slice(
      cssText.indexOf('.fold-row.is-running .fold-label,'),
      cssText.indexOf('.fold-row.is-running .fold-label,') + 700,
    );
    expect(live).toContain('font-weight: var(--font-weight-medium);');
  });

  it('pins the token count to tabular figures', () => {
    expect(cssText).toContain(
      '.activity-meta-time,\n.activity-meta-count {\n  font-variant-numeric: tabular-nums;\n}',
    );
  });

  it('airs out the expanded steps and weights the ones that matter', () => {
    expect(css('step-row').lineHeight).toBe('1.45');
    expect(cssText).toContain(
      '.step-row.is-error .step-label,\n.step-row.is-pending .step-label {',
    );
  });
});

describe('relay banner', () => {
  it('docks a centered pill at the top of the viewport', () => {
    const banner = css('relay-banner');
    expect(banner.position).toBe('fixed');
    expect(banner.display).toBe('flex');
  });

  it('keeps the status text on one line', () => {
    const text = css('relay-banner-text');
    expect(text.whiteSpace).toBe('nowrap');
  });
});
