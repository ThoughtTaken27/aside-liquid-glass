import { describe, expect, it } from 'vitest';
import { composeVisual, localRefs, visualTitle, visualVars } from './visual';

describe('visualVars', () => {
  it('keeps resolved app values, drops unresolved ones, adds the chart palette', () => {
    const vars = visualVars(
      { '--foreground': ' #202627 ', '--border': 'var(--x)', '--success': '#202627' },
      'light',
    );
    expect(vars['--foreground']).toBe('#202627');
    expect(vars['--border']).toContain('color-mix');
    expect(vars['--chart-1']).toBe('#e87d4f');
    // Success must not collapse into ink: deltas need to read as good/bad.
    expect(vars['--success']).not.toBe('#202627');
    expect(vars['--destructive']).not.toBe(vars['--chart-1']);
  });
});

describe('composeVisual', () => {
  const vars = visualVars({}, 'dark');
  it('injects theme, base styles and the height script right after <head>', () => {
    const out = composeVisual('<!doctype html><html><head><title>T</title></head><body>x</body></html>', vars, 'dark');
    expect(out.indexOf('--chart-1')).toBeLessThan(out.indexOf('<title>'));
    expect(out).toContain('color-scheme:dark');
    expect(out).toContain('aside-visual:h');
    expect(out).toContain('<base target="_blank">');
  });
  it('wraps a fragment and is deterministic, so the server can dedupe it', () => {
    const a = composeVisual('<div>frag</div>', vars, 'dark');
    expect(a).toMatch(/^<!doctype html><html><head>.*<\/head><body><div>frag<\/div><\/body><\/html>$/s);
    expect(composeVisual('<div>frag</div>', vars, 'dark')).toBe(a);
  });
  it('cannot be broken out of by a hostile variable value', () => {
    const out = composeVisual('<p/>', { '--foreground': 'red;}</style><script>x()</script>' }, 'light');
    expect(out).not.toContain('</style><script>x()');
  });
});

describe('helpers', () => {
  it('reads the title and local image references', () => {
    expect(visualTitle('<title> Revenue </title>')).toBe('Revenue');
    expect(visualTitle('<p/>')).toBe('Visual');
    expect(
      localRefs(`<img src="/Users/p/s/tmp/a.png"><div style="background:url('/Users/p/b.png')"></div><img src="https://x/y.png">`),
    ).toEqual(['/Users/p/s/tmp/a.png', '/Users/p/b.png']);
  });
});
