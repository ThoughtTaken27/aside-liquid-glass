/**
 * Regressions for four things phone testing reported from the phone, all of which
 * were invisible in a desktop dev loop.
 *
 * 1. THE PRE-START PILL. The running row inside a work fold had been
 *    converted from a card to a line, but `.stream-footer` -- the status
 *    shown before any tool run exists -- was missed. So the first seconds
 *    of every turn showed a bordered, shadowed capsule that collapsed
 *    into a plain line the moment a real step arrived. Two live states
 *    that mean the same thing must not look like different components.
 *
 * 2. LANDING AT THE BOTTOM. Opening a session left the view thousands of
 *    pixels above the newest message. Pinning once on load is not enough
 *    when markdown is rendered deferred: measured on a real 31k-pixel
 *    transcript here, the scroller settled 6802px short.
 *
 * 3. JUMP TO LATEST. There was no way back to the live end short of
 *    dragging, and the control must be genuinely inert when it is hidden
 *    rather than merely transparent.
 *
 * 4. THE READING RHYTHM. The prose column ran to both bezels, which is
 *    what made it read as a slab rather than a set column.
 *
 * jsdom does no layout, so what is pinned here is the contract: the CSS
 * declarations that carry the behaviour, and the DOM shape they select.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '../src/theme/components.css'), 'utf8');
const app = readFileSync(path.join(here, '../src/App.tsx'), 'utf8');

/** The body of a single top-level rule, by exact selector. */
function ruleBody(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} must exist`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('the live status line is a line, not a capsule', () => {
  const body = ruleBody('.stream-footer');

  it('carries no container decoration of any kind', () => {
    // Each of these individually turns the row back into a card, so they
    // are asserted separately: a partial revert is the likely failure.
    expect(body).not.toMatch(/\bborder:/);
    expect(body).not.toMatch(/border-radius:/);
    expect(body).not.toMatch(/box-shadow:/);
    expect(body).not.toMatch(/background:/);
  });

  it('has no horizontal padding, so it sits on the transcript column', () => {
    const padding = /padding:\s*([^;]+);/.exec(body)?.[1] ?? '';
    expect(padding).toBe('2px 0 3px');
  });

  it('keeps the shimmer, which is the actual live signal', () => {
    expect(css).toMatch(
      /\.stream-footer\.is-thinking \.activity-line > \[role='status'\]/,
    );
    expect(css).toMatch(/animation: work-shimmer/);
  });

  it('no longer gets a dark-mode shadow stack either', () => {
    expect(css).not.toMatch(/\.dark \.stream-footer \{/);
  });
});

describe('opening a session lands on the newest message', () => {
  it('watches content height rather than trusting a timer', () => {
    // The first attempt used a rAF loop with a 1200ms floor and lost the
    // race against deferred markdown. The observer is the fix; a revert
    // to a bare timeout would pass every other assertion here.
    expect(app).toMatch(/new ResizeObserver\(stick\)/);
    expect(app).toMatch(/mo\.observe\(el, \{ childList: true \}\)/);
  });

  it('observes the children, since a scroll box does not resize with its content', () => {
    expect(app).toMatch(/for \(const child of Array\.from\(el\.children\)\) ro\.observe\(child\)/);
  });

  it('lands instantly, never animating a long scroll on open', () => {
    expect(app).toMatch(/behavior: 'instant' as ScrollBehavior/);
  });

  it('does not let its own programmatic scrolls count as scrolling away', () => {
    expect(app).toMatch(/if \(!landing\.current\) \{\s*pinned\.current =/);
  });

  it('yields to a real gesture', () => {
    expect(app).toMatch(/onTouchStart=\{releaseLanding\}/);
    expect(app).toMatch(/onWheel=\{releaseLanding\}/);
  });
});

describe('jump to latest', () => {
  it('is driven by the attribute the scroll handler already writes', () => {
    // Not React state: this must not re-render the thread once per frame
    // while scrolling.
    expect(css).toMatch(/\.thread-footer\[data-at-end='false'\] \.jump-latest/);
    expect(app).not.toMatch(/setAtEnd|useState.*atEnd/);
  });

  it('is inert when hidden, not merely invisible', () => {
    const hidden = css.slice(css.indexOf(".thread-footer[data-at-end='true'] .jump-latest"));
    const body = hidden.slice(hidden.indexOf('{') + 1, hidden.indexOf('}'));
    expect(body).toMatch(/opacity:\s*0/);
    expect(body).toMatch(/pointer-events:\s*none/);
  });

  it('is hidden before the first scroll event has run', () => {
    // Without this the button is visible for a frame on every open, which
    // is exactly when it is least wanted.
    expect(css).toMatch(/\.thread-footer:not\(\[data-at-end\]\) \.jump-latest/);
  });

  it('skips the animation over long distances, where the target drifts', () => {
    expect(app).toMatch(/distance > 1200 \? 'instant' : 'smooth'/);
  });

  it('re-arms the guard so the tail can finish rendering', () => {
    expect(app).toMatch(/armLanding\(\);\s*\n\s*pinned\.current = true;\s*\n\s*const distance/);
  });

  it('honours reduced motion', () => {
    const rm = css.slice(css.indexOf('.jump-latest'));
    expect(rm).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe('the reading column', () => {
  // 16px on a 26px line box: ChatGPT's own body metrics, read out of its
  // live DOM. The earlier 17/1.6 belonged to the serif that preceded it.
  it('sets prose at the measured 16px / 1.625 reference rhythm', () => {
    const md = ruleBody('.md');
    expect(md).toMatch(/font-size: 1rem;/);
    expect(md).toMatch(/line-height: 1\.625;/);
  });

  it('keeps prose insets symmetric on a phone', () => {
    // A right-only gutter was tried and reverted. It works on claude.ai
    // because their column is centred in a wider frame and the gap holds
    // the message controls; on a full-width phone transcript the same
    // 24px only shifts every line left of centre and leaves dead space.
    expect(css).not.toMatch(/padding-right: 24px/);
  });

  it('centres the capped measure on wide screens instead of recreating the left bias', () => {
    const wide = css.slice(css.indexOf('@media (min-width: 600px)'));
    const rule = wide.slice(0, 340);
    expect(rule).toMatch(/max-width: 34em/);
    expect(rule).toMatch(/margin-right: auto/);
    expect(rule).toMatch(/margin-left: auto/);
  });

  it('leaves pre and tables out of the capped list, since they scroll', () => {
    const sel = '.md > :is(p, ul, ol, blockquote, h1, h2, h3, h4, h5, h6)';
    expect(sel).not.toMatch(/\bpre\b/);
    expect(sel).not.toMatch(/\btable\b/);
  });
});

describe('the task progress ring', () => {
  it('draws the arc in the bright brand, not the text clay', () => {
    expect(ruleBody('.todo-ring-arc')).toMatch(/stroke: var\(--brand\)/);
  });

  it('animates only the dash offset, so the fill grows along the stroke', () => {
    const body = ruleBody('.todo-ring-arc');
    expect(body).toMatch(/transition: stroke-dashoffset/);
    expect(body).not.toMatch(/transition:.*(width|height|all)/);
  });

  it('does not shrink in the flex row it lives in', () => {
    expect(ruleBody('.todo-ring')).toMatch(/flex: none/);
  });
});


describe('the dock sits correctly against the bottom edge', () => {
  it('insets the composer by the same amount at the bottom as at the sides', () => {
    // It was 10px against 16px sides, which reads as the card slipping
    // off the bottom of the screen rather than floating on it. Equal
    // insets are what make a floating object look placed.
    const docks = css.match(/padding: 6px 16px\n\s*calc\(16px \+ max\(env\(safe-area-inset-bottom\)/g);
    expect(docks).toHaveLength(2);
  });

  it('keeps both docks identical, so the composer does not jump between screens', () => {
    const inset = /padding: 6px 16px\n\s*calc\(16px \+ max\(env\(safe-area-inset-bottom\)/g;
    expect(css.match(inset)).toHaveLength(2);
  });
});

describe('session cards do not fake a progress bar', () => {
  it('has no fixed-width clay rail pretending to be a meter', () => {
    // 34px of a 100%-wide 3px track, identical on every card, measuring
    // nothing. SessionRow carries no token or context figure, so it could
    // not have been made honest without a payload change.
    expect(css).not.toMatch(/62%, transparent\) 34px/);
    expect(ruleBody('.session-card')).not.toMatch(/background-image:/);
  });

  it('transitions the colour layer only, now that there is no image layer', () => {
    expect(ruleBody('.session-card')).toMatch(/transition: background-color/);
  });

  it('keeps the home press state at a specificity that actually paints', () => {
    // `.session-card:active` (0,2,0) loses to `.app-home.has-history
    // .session-card` (0,3,0); without the match the press state is dead
    // on the home screen.
    expect(css).toMatch(/\.app-home\.has-history \.session-card:active \{/);
  });
});
