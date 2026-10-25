/**
 * Chat open, round 2 (Oct 10): what still moved after the history was shown.
 *
 * Traced frame by frame on a production build with a 900ms thread fetch:
 *
 * 1. VISUALS. Every inline visual started as a 44px line, became a 160px
 *    frame, then grew to its page's height with a height transition: the
 *    answer grew ~900px while visible and a chat pinned to its end slid with
 *    it. Heights now persist across launches; a page's reports before its
 *    load are provisional; the history waits for unsized visuals.
 * 2. THE HEADER said "Conversation" and the default model until the fetch
 *    landed, and the landing scroll condensed it (title slid 9px).
 * 3. THE SKELETON unmounted before the history was shown: a blank beat.
 * 4. THE SEND BUTTON popped in on every open.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readThreadMeta, resetThreadMetaForTests, writeThreadMeta } from '../src/utils/threadMeta';
import { knownVisualHeight } from '../src/components/VisualBlock';
import { nowContext } from '../src/components/NextToday';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, '..', p), 'utf8');

describe('thread meta seed', () => {
  beforeEach(() => {
    localStorage.clear();
    resetThreadMetaForTests();
  });

  it('round-trips through storage across a relaunch', () => {
    writeThreadMeta('a', {
      title: 'Plan the week',
      model: { provider: 'p', modelId: 'm', label: 'Model M', effort: null, effortLabel: null },
      permissionMode: 'full-access',
    });
    resetThreadMetaForTests();
    expect(readThreadMeta('a')?.title).toBe('Plan the week');
    expect(readThreadMeta('a')?.model?.label).toBe('Model M');
    expect(readThreadMeta('a')?.permissionMode).toBe('full-access');
  });

  it('keeps only the newest 200 chats', () => {
    for (let i = 0; i < 205; i++) writeThreadMeta(`s${i}`, { title: `t${i}` });
    resetThreadMetaForTests();
    expect(readThreadMeta('s0')).toBeUndefined();
    expect(readThreadMeta('s4')).toBeUndefined();
    expect(readThreadMeta('s5')?.title).toBe('t5');
    expect(readThreadMeta('s204')?.title).toBe('t204');
  });

  it('survives a corrupt store', () => {
    localStorage.setItem('aside.threadMeta.v1', '{not json');
    resetThreadMetaForTests();
    expect(readThreadMeta('x')).toBeUndefined();
  });
});

describe('the thread screen draws its first frame from what it knows', () => {
  const app = read('src/App.tsx');

  it('seeds the title from Recents and the model from the last visit', () => {
    expect(app).toMatch(/seedTitle=\{sessions\.find\(\(row\) => row\.id === screen\.id\)\?\.title\}/);
    expect(app).toMatch(/const shownTitle = thread\.title \|\| seedTitle \|\| cachedMeta\?\.title/);
    expect(app).toMatch(/resolveThreadModel\(shownModel, pills, catalog\)/);
    expect(app).not.toMatch(/\{thread\.title \|\| 'Conversation'\}/);
  });

  it('holds the subtitle line invisibly instead of showing a default model', () => {
    expect(app).toMatch(/data-pending=\{subtitlePending \? 'true' : undefined\}/);
    expect(read('src/theme/craft.css')).toMatch(/\.thread-subtitle\[data-pending\] \{\s*opacity: 0;/);
  });

  it('never repositions the title from a scroll direction change', () => {
    expect(app).toContain('className="thread-header" data-condensed="false"');
    expect(app).not.toContain('threadHeader.current.dataset.condensed');
  });

  it('keeps the skeleton until the history is shown, then crossfades', () => {
    expect(app).toMatch(/onReveal=\{onHistoryReveal\}/);
    expect(app).toMatch(/className="thread-skeleton-dock" data-leaving=\{historyShown/);
    const css = read('src/theme/craft.css');
    expect(css).toMatch(/\.thread-skeleton-dock \{\s*position: sticky;\s*top: 0;\s*height: 0;/);
  });

  it('a running tail arrives with the history, not before it', () => {
    expect(read('src/theme/craft.css')).toMatch(
      /\.thread-scroll:has\(> \.thread\[data-revealed='settling'\]\) :is\(\.work\.is-live-tail, \.stream-footer\) \{\s*opacity: 0;/,
    );
  });
});

describe('visual heights', () => {
  it('reads remembered heights per block and width', () => {
    localStorage.clear();
    expect(knownVisualHeight('<p>never seen</p>')).toBeNull();
  });

  it('treats reports before the frame loads as provisional', () => {
    const src = read('src/components/VisualBlock.tsx');
    expect(src).toMatch(/if \(loadedAt\.current === null\) return;/);
    expect(src).toMatch(/loadedAt\.current \+ 1300/);
    expect(src).toMatch(/data-sized=\{height \? 'true' : undefined\}/);
  });

  it('the history waits for unsized visuals, up to a ceiling', () => {
    expect(read('src/components/Thread.tsx')).toMatch(/querySelector\('\.md-visual:not\(\[data-ready\]\)'\)/);
  });

  it('a frame fades into its box; only later size changes ease', () => {
    const css = read('src/theme/craft.css');
    expect(css).toMatch(/\.md-visual iframe:not\(\[data-drawn\]\) \{\s*opacity: 0;\s*transition: none;/);
  });
});

describe('send button', () => {
  it('animates a real swap, never a mount', () => {
    const composer = read('src/components/Composer.tsx');
    expect(composer).toMatch(/if \(entered\.current && lastSwapKey\.current !== swapKey\) el\.dataset\.swapIn = 'true';/);
    expect(read('src/theme/craft.css')).toMatch(/\.round-button\.send > :not\(\[data-swap-in\]\)/);
  });
});

describe('Next: the card does not repeat its own title', () => {
  const base = { taint: 'task' as const, sender: undefined };
  it('drops a context line the title already contains', () => {
    expect(
      nowContext({ ...base, title: 'Apply for the Stan & Thelma Plumlee Trade School Scholarship', context: 'Stan & Thelma Plumlee Scholarship' } as never),
    ).toBe('');
  });
  it('keeps a context line that adds something', () => {
    expect(nowContext({ ...base, title: 'Confirm personal essay is final', context: 'College applications' } as never)).toBe(
      'College applications',
    );
  });
});

describe('launch entrance', () => {
  it('the logo and greeting entrance is not overridden away', () => {
    const craft = read('src/theme/craft.css');
    expect(craft).not.toMatch(/\.rest-hero\.is-first \.rest-mark > svg \{\s*animation: page-fade-in/);
    expect(craft).not.toMatch(/\.rest-mark::after \{ display: none; \}/);
    expect(read('src/theme/fits.css')).toMatch(/\.rest-hero\.is-first \.rest-mark > svg \{\s*animation: fp-ignite/);
  });
  it('the mark and the app icon use the clay orange', () => {
    expect(read('src/theme/fits.css')).toMatch(/--fp-glow: #e87d4f;/);
    expect(read('public/manifest.webmanifest')).toContain('/icons/aside-clay-512.png');
  });
});
