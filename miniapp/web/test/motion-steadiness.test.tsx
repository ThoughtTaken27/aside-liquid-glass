/**
 * Steadiness regressions from phone testing (Oct 10).
 *
 * 1. LAUNCH HOP. The history cue appeared only once Recents loaded, and its
 *    44px pushed the centred greeting up 22px half a second after launch.
 *    While Recents is loading the cue's place is held by an invisible
 *    stand-in.
 *
 * 2. CHAT-OPEN JITTER. The history was shown while its row heights, the
 *    landing and markdown were still settling. It is now laid out hidden
 *    ('settling') and revealed once, opacity only.
 *
 * 3. BLANK AFTER THE SKELETON. A superseded load could end the loading state
 *    early, and a socket closed during cleanup could be reopened by a load
 *    landing afterwards.
 *
 * 4. BACK STUTTER. Home was rebuilt on every Back; it now stays mounted,
 *    inert and frozen under other screens.
 *
 * 5. THE "/" MENU above the keyboard fits the space it has, so the field
 *    being typed into stays visible.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { RestCue } from '../src/components/Rest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, '..', p), 'utf8');

describe('launch: the history cue holds its place', () => {
  it('renders an invisible stand-in while Recents is loading', () => {
    const { container } = render(<RestCue count={0} pending onOpen={() => {}} />);
    const stand = container.querySelector('.rest-cue.rest-cue-pending');
    expect(stand).not.toBeNull();
    expect(stand?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders nothing once loaded with no history', () => {
    const { container } = render(<RestCue count={0} onOpen={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('App passes the loading state through', () => {
    expect(read('src/App.tsx')).toMatch(/<RestCue count=\{sessions\.length\} pending=\{loadingSessions && sessions\.length === 0\}/);
  });

  it('the stand-in has the cue box and is hidden', () => {
    const css = read('src/theme/craft.css');
    const at = css.indexOf('.rest-cue.rest-cue-pending {');
    expect(at).toBeGreaterThan(-1);
    const body = css.slice(at, css.indexOf('}', at));
    expect(body).toMatch(/visibility: hidden/);
    expect(body).toMatch(/height: 44px/);
  });
});

describe('chat open: history settles hidden, then fades once', () => {
  const thread = read('src/components/Thread.tsx');
  const css = read('src/theme/craft.css');

  it('goes pending -> settling -> fade', () => {
    expect(thread).toMatch(/'pending' \| 'settling' \| 'fade'/);
    expect(thread).toMatch(/const settled = still >= 6 && atEnd/);
    expect(thread).toMatch(/if \(plain\)/);
    expect(thread).toContain('rows.flatMap(row => [row.offsetTop, row.offsetHeight])');
    expect(thread).toMatch(/const ceiling = unsized \? 2200 : 700;/);
    expect(thread).toMatch(/performance\.now\(\) - started > ceiling/);
  });

  it('hides while settling and reveals with opacity only', () => {
    expect(css).toMatch(/\.thread\[data-revealed='settling'\] > \[data-content-surface='thread-content'\] \{\s*opacity: 0;/);
    const at = css.indexOf('@keyframes thread-reveal');
    const body = css.slice(at, css.indexOf('}\n}', at));
    expect(body).not.toMatch(/transform|translate/);
  });
});

describe('thread loading races', () => {
  const hook = read('src/hooks/useThread.ts');

  it('only the newest load ends the loading state', () => {
    expect(hook).toMatch(/if \(alive\.current && sequence === loadSequence\.current\) setLoading\(false\)/);
  });

  it('a disposed run never reopens its socket', () => {
    expect(hook).toMatch(/if \(connectStarted \|\| disposed \|\| !alive\.current\) return;/);
    expect(hook).toMatch(/return \(\) => \{\s*disposed = true;/);
  });
});

describe('Back: Home stays mounted under other screens', () => {
  const app = read('src/App.tsx');
  const css = read('src/theme/craft.css');

  it('renders Home beside the overlay and freezes it while covered', () => {
    expect(app).toMatch(/frozenHome\.current = \{ node: renderHome\(covered\), covered \}/);
    expect(app).toMatch(/\{frozenHome\.current!\.node\}\s*\{overlay\}/);
    expect(app).toMatch(/inert=\{covered \|\| undefined\}/);
  });

  it('a covered Home drops its sheets and toasts', () => {
    expect(app).toMatch(/\{covered \? null : renderPicker\(/);
    expect(app).toMatch(/\{covered \? null : <ToastHost \/>\}/);
  });

  it('a covered Home is out of layout, paint and hit-testing', () => {
    const at = css.indexOf('#root > .app-home[data-covered] {');
    expect(at).toBeGreaterThan(-1);
    const body = css.slice(at, css.indexOf('}', at));
    for (const rule of ['position: absolute', 'visibility: hidden', 'content-visibility: hidden', 'pointer-events: none']) {
      expect(body).toContain(rule);
    }
  });

  it('leaving a chat lands on the home page, not back in Recent work', () => {
    // The helper clears both the saved scroll and the card anchor...
    expect(app).toMatch(/const homeFromTop = useCallback\(\(\) => \{\s*homeOffset\.current = 0;\s*homeAnchor\.current = null;/);
    // ...and every way out of the last chat calls it: the back button,
    // the system back gesture, and New chat from inside a thread.
    expect(app).toMatch(/if \(stack\.length <= 1\) \{\s*homeFromTop\(\);/);
    expect(app).toMatch(/if \(index === 0\) \{ homeFromTop\(\);/);
    expect(app).toMatch(/setNextOpen\(false\);\s*homeFromTop\(\);\s*setStack\(\[\]\);/);
  });

  it('restoring Home scroll never inherits smooth scrolling', () => {
    expect(app).toMatch(/el\.scrollTo\(\{ top, behavior: instant \}\)/);
    expect(app).not.toMatch(/el\.scrollTop = homeOffset\.current;/);
  });
});

describe('"/" menu fits above the keyboard', () => {
  it('measures the room between the header and the composer top', () => {
    const menu = read('src/components/SlashMenu.tsx');
    expect(menu).toMatch(/slashRoom\(cardBox\.top, headerBottom\)/);
    expect(menu).toMatch(/Math\.max\(132, Math\.min\(420, /);
  });
});
