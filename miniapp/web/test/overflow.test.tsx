/**
 * Regression tests for the horizontal-overflow bug a user hit in the
 * field: a model id like `oc/deepseek-v4-flash-free(max)` made the
 * composer's model pill wider than the phone, which panned the ENTIRE app
 * sideways in Telegram's webview -- every screen was cut off at the left
 * edge.
 *
 * jsdom does no layout, so the width math itself cannot be asserted here.
 * What can be pinned is the contract that makes the layout safe:
 *
 * 1. The stylesheet rules that let a pill shrink and ellipsize, clamp the
 *    root against horizontal panning, and truncate the subagent model
 *    badge. These are load-bearing lines of CSS; losing any one of them
 *    in a refactor re-opens the bug silently.
 * 2. The DOM shape those rules select on: the label lives in
 *    `.pill-label`, the effort pill opts out of shrinking via
 *    `.pill-effort`, and the subagent badge wraps its text in
 *    `.subagent-model-label`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Composer } from '../src/components/Composer';
import type { PillState } from '../src/components/Composer';

afterEach(cleanup);

const here = path.dirname(fileURLToPath(import.meta.url));
const componentsCss = readFileSync(
  path.join(here, '../src/theme/components.css'),
  'utf8',
);
const baseCss = readFileSync(
  path.join(here, '../src/theme/base.css'),
  'utf8',
);
const tokensCss = readFileSync(
  path.join(here, '../src/theme/tokens.css'),
  'utf8',
);

/**
 * Every declaration applied to a selector, across all of its rules, with
 * comments stripped -- a comment MENTIONING `flex: none` must not read as
 * the declaration itself.
 */
function ruleBody(css: string, selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(
    `(?:^|\\n)(?:[^{}\\n]*,\\s*\\n)*${escaped}(?:\\s*,[^{]*)?\\s*\\{([^}]*)\\}`,
    'g',
  );
  let body = '';
  for (const match of bare.matchAll(rule)) body += match[1];
  return body;
}

const LONG_MODEL = 'oc/deepseek-v4-flash-free(max)';

const pills: PillState = {
  modelLabel: LONG_MODEL,
  effortLabel: 'High',
  effortId: 'high',
  provider: 'openrouter',
};

/*
 * There is one surface now.
 *
 * `BottomBar` was a second control row carrying its own permission button,
 * context ring and model pill. Nothing rendered it -- the composer took
 * over both screens -- so it sat here being tested while the code it
 * duplicated drifted. It is gone, and with it the only reason these cases
 * had to be written twice.
 */
function renderComposer(permissionMode = 'guard') {
  return render(
    <Composer
      variant="home"
      value=""
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      pills={pills}
      onOpenModel={vi.fn()}
      permissionMode={permissionMode}
      attachments={[]}
      onAddFiles={vi.fn()}
      onRemoveAttachment={vi.fn()}
    />,
  );
}

describe('the pill cannot widen the app', () => {
  it('.pill shrinks instead of overflowing', () => {
    const body = ruleBody(componentsCss, '.pill');
    expect(body).toContain('min-width: 0');
    expect(body).toContain('flex: 0 1 auto');
    expect(body).toContain('max-width: 100%');
    expect(body).not.toContain('flex: none');
  });

  it('.pill-label ellipsizes', () => {
    const body = ruleBody(componentsCss, '.pill-label');
    expect(body).toContain('overflow: hidden');
    expect(body).toContain('text-overflow: ellipsis');
  });

  it('the effort pill opts back out of shrinking', () => {
    expect(ruleBody(componentsCss, '.pill-effort')).toContain('flex: none');
  });

  it('the composer carries exactly one pill: the model', () => {
    // Reasoning moved into the model sheet, so the action row has a single
    // pill to fit. That is what stopped the label ellipsising to
    // "DeepSee…" inside a 336px card.
    const { container } = renderComposer();
    const found = Array.from(container.querySelectorAll('.pill'));
    expect(found.length).toBe(1);
    expect(found[0].classList.contains('pill-effort')).toBe(false);
  });

  it('the composer never renders an effort pill', () => {
    const { container } = renderComposer();
    expect(container.querySelector('.pill-effort')).toBeNull();
  });

  it('the pill carries no chevron, so the label keeps that width', () => {
    // The caret repeated what a filled capsule in a row of buttons already
    // says, and it cost the label ~17px on the narrowest phone.
    const { container } = renderComposer();
    expect(container.querySelector('.pill svg.lucide-chevron-down')).toBeNull();
    expect(container.querySelector('.pill')?.querySelectorAll('svg').length ?? 0)
      .toBeLessThanOrEqual(1);
  });

  it('the long model id renders inside .pill-label', () => {
    const { container } = renderComposer();
    const labels = Array.from(container.querySelectorAll('.pill-label'));
    // The pill drops a trailing parenthetical qualifier -- see
    // `pillModelLabel` -- so the id renders without its "(max)" suffix.
    // What matters here is that it is inside .pill-label, which is the
    // element carrying the ellipsis.
    expect(labels.map((el) => el.textContent)).toContain(
      'oc/deepseek-v4-flash-free',
    );
  });
});

describe('the root clamps panning', () => {
  /*
   * This asserted `overflow-x: hidden` alone. The rule is now the
   * shorthand `overflow: hidden`, which clips both axes, and the vertical
   * half is load-bearing: the context gauge hangs below the composer
   * card, and where a device reports no safe-area inset it finished a few
   * pixels past the viewport and made the whole document scrollable. The
   * app then appeared to slide up and down at rest on a screen with
   * nothing to scroll.
   *
   * Matching the shorthand rather than the longhand also stops this test
   * failing for a rule that is strictly stronger than the one it wants.
   */
  it('html/body clip both axes', () => {
    // The guard is one rule on `html, body`; match it wherever it lives.
    expect(baseCss).toMatch(
      /html,\s*\nbody\s*\{[^}]*overflow:\s*hidden/,
    );
  });

  it('page-sized vertical scrollers cannot pan sideways', () => {
    for (const selector of [
      '.home',
      '.thread-scroll',
      '.settings-scroll',
      '.sheet-body',
      '.home-scroll',
    ]) {
      const body = ruleBody(componentsCss, selector);
      expect(body).toContain('overflow-x: hidden');
      expect(body).toContain('overscroll-behavior-x: none');
      expect(body).toContain('touch-action: pan-y');
    }
  });

  it('keeps local code and table readers horizontally scrollable', () => {
    expect(ruleBody(componentsCss, '.md pre')).toContain('overflow-x: auto');
    expect(ruleBody(componentsCss, '.md-pre-shiki')).toContain('overflow-x: auto');
    expect(ruleBody(componentsCss, '.md table')).toContain('overflow-x: auto');
  });
});

describe('the subagent model badge truncates', () => {
  it('.subagent-model shrinks and its label ellipsizes', () => {
    const badge = ruleBody(componentsCss, '.subagent-model');
    expect(badge).toContain('flex: 0 1 auto');
    expect(badge).toContain('min-width: 0');

    const label = ruleBody(componentsCss, '.subagent-model-label');
    expect(label).toContain('overflow: hidden');
    expect(label).toContain('text-overflow: ellipsis');
    expect(label).toContain('white-space: nowrap');
  });
});

/*
 * One left edge for the whole transcript.
 *
 * The reported symptom was "the text is way too left oriented": work rows
 * indent their sentence past a tool glyph and prose did not, so mid-turn
 * commentary and the final answer both began 20px to the left of every
 * summary around them. A turn alternates between the two, so the page
 * read as a saw-tooth with the largest type always sticking out.
 *
 * The fix is a shared gutter token rather than four hand-matched numbers,
 * and this locks that in. It is a CSS-level assertion because the rule is
 * a relationship BETWEEN selectors: any one of them can be edited without
 * looking wrong on its own, and the column silently breaks.
 */
describe('the single accent system', () => {
  it("anchors both themes to the owner's exact orange", () => {
    expect(tokensCss.match(/--brand:\s*#e87d4f;/g)).toHaveLength(2);
  });

  it('keeps the exact orange on graphics and contrast-safe variants on text', () => {
    expect(tokensCss).toContain('--brand-text: oklch(56.9% 0.1455 43.1)');
    expect(tokensCss).toContain(
      '--brand-foreground: var(--color-neutral-950)',
    );
    expect(ruleBody(componentsCss, '.rest-mark')).toContain('var(--brand)');
    expect(ruleBody(componentsCss, '.settings-brand')).toContain('var(--brand)');
    expect(ruleBody(componentsCss, '.boot-retry')).toContain(
      'color: var(--brand-foreground)',
    );
  });

  it('keeps semantic dots and animated text contrast-safe', () => {
    const unread = ruleBody(componentsCss, '.unread-dot');
    expect(unread).toContain('background: var(--brand)');
    expect(unread).toContain('var(--brand-text)');

    const liveText = ruleBody(
      componentsCss,
      ".stream-footer.is-working .activity-line > [role='status']",
    );
    expect(liveText).toContain('var(--brand-text)');
    expect(liveText).not.toMatch(/var\(--brand\)(?!-text)/);

    const ultrabrowse = ruleBody(
      componentsCss,
      '.popover-row.is-ultrabrowse .popover-row-label',
    );
    expect(ultrabrowse).toContain('var(--brand-text)');
    expect(ultrabrowse).not.toMatch(/var\(--brand\)(?!-text)/);
  });

  /*
   * Inline code is a change of register, not of emphasis.
   *
   * It used to be clay on both axes, which spotted a page of prose with
   * pink chips and, because the mix was part accent and part body ink,
   * landed on neither colour. The monospace face is the signal; the wash
   * only bounds the span. This is a CSS-level assertion because the rule
   * is an absence -- nothing renders wrong on its own, the accent just
   * creeps back in one span at a time.
   */
  it('keeps inline code neutral so the distributed accent stays intentional', () => {
    const code = ruleBody(componentsCss, '.md code');
    expect(code).toContain('var(--foreground)');
    expect(code).not.toContain('--brand');
  });

  it('does not ship a second chromatic ramp', () => {
    expect(tokensCss).not.toMatch(
      /--color-(?:red|orange|amber|green|emerald|sky|blue|violet|pink)-/,
    );
    expect(componentsCss).not.toContain('--ultrabrowse-red');
  });

  it('keeps selection in the same accent family', () => {
    expect(ruleBody(baseCss, '::selection')).toContain('var(--brand)');
  });
});

describe('the transcript column', () => {
  /*
   * Nothing in a turn is indented past the page padding.
   *
   * The first version of this fix kept the summary rows' tool glyph and
   * indented all prose 20px to match it. That produced one edge and a
   * congested middle: the reading column lost 20px on a 393px screen and
   * the margins came out 38 against 18. The glyph is gone now and the
   * column is simply the padding, so what has to be guarded is the
   * ABSENCE of the indents -- they are easy to reintroduce one selector
   * at a time, and each one on its own looks reasonable.
   */
  for (const selector of ['.turn-answer', '.work-text', '.answer']) {
    it(`leaves ${selector} on the page column`, () => {
      expect(ruleBody(componentsCss, selector)).not.toMatch(/padding-left/);
      expect(ruleBody(componentsCss, selector)).not.toMatch(/margin-left/);
    });
  }

  it('aligns the quiet measurements under the marked live heading', () => {
    const mark = ruleBody(componentsCss, '.activity-mark');
    const meta = ruleBody(componentsCss, '.activity-meta');
    expect(mark).toContain('var(--meta-slot)');
    expect(meta).toContain(
      'padding-left: calc(var(--meta-slot) + var(--meta-gap))',
    );
  });

  it('keeps the page padding symmetric', () => {
    const body = ruleBody(componentsCss, '.thread-scroll');
    const padding = body.match(/padding:\s*([^;]+);/)?.[1] ?? '';
    // `14px 20px 0` -- top, sides, bottom. One value for both sides is
    // the only way the margins cannot drift apart again.
    expect(padding.trim().split(/\s+/)).toHaveLength(3);
  });
});

/**
 * The task list.
 *
 * A CSS-level assertion for the same reason as the accent rules above:
 * the bug is a default, not a declaration. An icon with no rule of its
 * own inherits `flex-shrink: 1` and is quietly squeezed by whichever rows
 * happen to wrap, so the list renders one icon at several sizes and every
 * individual rule still looks correct in isolation.
 */
describe('the task list', () => {
  it('never lets a wrapped row squeeze its mark', () => {
    expect(ruleBody(componentsCss, '.todo-row > svg')).toContain('flex: none');
  });

  it('centres the mark on the first line rather than the block', () => {
    // `flex-start` is what keeps the mark beside line one of a two-line
    // task; the offset is what stops it sitting on the cap line.
    expect(ruleBody(componentsCss, '.todo-row')).toContain('flex-start');
    expect(ruleBody(componentsCss, '.todo-row > svg')).toContain('margin-top');
  });
});

/**
 * The palette, as a rule rather than a habit.
 *
 * Two hues exist in this product: 92 for every neutral, 43.1 for the orange.
 * A neutral is not "a grey", it is hue 92 desaturated, and a surface that
 * wanders off the axis reads as a different temperature from the page it
 * sits on.
 *
 * This is a test because the failure is invisible token by token. The
 * light neutrals had drifted onto four hues -- 95.1, 100, 106 and a pure
 * white 0 -- and not one of those looks wrong on its own; it only shows
 * up assembled, as a cream page under a faintly green input under a
 * pure-white sheet. Nobody reviews a diff and catches `106` where `100`
 * was meant, so the reviewer is here instead.
 */
describe('the neutral axis', () => {
  // Every stylesheet, not just the token file: the drift that caused this
  // lived in component rules too, where a one-off shadow colour is easiest
  // to type from memory and hardest to notice.
  const declarations = [baseCss, tokensCss, componentsCss].flatMap((sheet) =>
    [...sheet.matchAll(/oklch\(\s*([0-9.]+)%\s+([0-9.]+)\s+([0-9.]+)/g)].map(
      ([, l, c, h]) => ({ l: +l, c: +c, h: +h }),
    ),
  );

  it('parses a palette at all, so a silent regex change cannot pass this file', () => {
    expect(declarations.length).toBeGreaterThan(50);
  });

  it('puts every coloured token on the neutral axis or the orange', () => {
    // Chroma 0 is exempt: it is achromatic by construction, which is what
    // a drop shadow and a white rim highlight are supposed to be.
    const strays = declarations
      .filter((d) => d.c > 0 && d.h !== 92 && d.h !== 43.1)
      .map((d) => `oklch(${d.l}% ${d.c} ${d.h})`);
    expect(strays).toEqual([]);
  });

  it('keeps raised surfaces warmer than the page, never cooler', () => {
    // A card less warm than its ground reads as grey rather than lifted,
    // which is the specific way this broke before.
    const grab = (token: string) => {
      const m = tokensCss.match(
        new RegExp(`${token}:\\s*oklch\\(\\s*([0-9.]+)%\\s+([0-9.]+)`),
      );
      return m ? { l: +m[1], c: +m[2] } : null;
    };
    const page = grab('--background');
    const card = grab('--surface-primary');
    expect(page).not.toBeNull();
    expect(card).not.toBeNull();
    expect(card!.l).toBeGreaterThan(page!.l);
    expect(card!.c).toBeGreaterThanOrEqual(page!.c * 0.7);
  });
});

/**
 * Paper grain.
 *
 * Two assertions only, and both are about the coupling rather than the
 * look. The grain is a grey wash, so it shifts the lightness of whatever
 * it lies on, and the page tokens are set to pay for that shift in
 * advance. Someone retuning the paper without the grain in mind gets a
 * page that is a point off in a direction nothing on screen explains.
 */
describe('paper grain', () => {
  it('is defined for both themes and applied to the page, not to cards', () => {
    expect(tokensCss.match(/--grain:\s*url\("data:image\/svg\+xml/g)).toHaveLength(2);
    // The page carries texture; raised surfaces stay smooth, which is what
    // makes the texture read as a surface boundary instead of noise.
    expect(ruleBody(componentsCss, '.app')).toContain('var(--grain)');
    expect(ruleBody(componentsCss, '.composer')).not.toContain('var(--grain)');
  });

  it('desaturates the noise so it cannot introduce a third hue', () => {
    // feTurbulence emits colour noise. On a two-hue palette that is a third
    // hue smeared across every pixel of the app.
    const grains = tokensCss.match(/--grain:[^;]+;/g) ?? [];
    expect(grains).toHaveLength(2);
    for (const g of grains) {
      expect(decodeURIComponent(g)).toContain("type='saturate' values='0'");
    }
  });
});
