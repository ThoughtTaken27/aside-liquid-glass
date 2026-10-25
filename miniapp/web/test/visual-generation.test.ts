/**
 * The generation build rides inside the visual's own page, and only when
 * asked: history composes exactly as before, so its bytes (and the
 * server's dedupe id) do not change.
 */
import { describe, expect, it } from 'vitest';
import { composeVisual } from '../src/utils/visual';

const runtime = 'const x = 1;\nexport function generate(el) { return el; }\nexport function auto() {}\nif (typeof window !== "undefined") window.UIGeneration = { generate, auto };';
const css = '.t-gen { position: absolute; }';

describe('composeVisual with a generation build', () => {
  it('leaves a plain compose byte-identical', () => {
    const a = composeVisual('<p>hi</p>', { '--foreground': '#111' }, 'light');
    const b = composeVisual('<p>hi</p>', { '--foreground': '#111' }, 'light', undefined);
    expect(a).toBe(b);
    expect(a).not.toContain('UIGeneration');
    expect(a).not.toContain('data-aside-gen');
  });

  it('inlines the runtime as a classic script and hides the page until the build starts', () => {
    const page = composeVisual('<p>hi</p>', {}, 'dark', { runtime, css });
    expect(page).toContain('window.UIGeneration');
    expect(page).not.toMatch(/^export\s/m);
    expect(page).toContain('html[data-aside-gen] body{opacity:0!important}');
    expect(page).toContain("setAttribute('data-aside-gen','')");
    expect(page).toContain('aside-visual:generated');
    // The page itself still comes after the head.
    expect(page.indexOf('<p>hi</p>')).toBeGreaterThan(page.indexOf('UIGeneration'));
  });

  it('cannot be broken out of by a closing tag inside the runtime', () => {
    const page = composeVisual('<p>x</p>', {}, 'light', { runtime: 'var s = "</script><b>";', css });
    expect(page).not.toContain('"</script><b>"');
  });
});
