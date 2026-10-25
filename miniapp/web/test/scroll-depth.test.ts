import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const read = (p: string) => readFileSync(path.resolve('src', p), 'utf8');
describe('scrolling preserves reading geometry', () => {
  it('does not scale or fade reading surfaces as they scroll', () => {
    // Scroll-driven typography deformation amplified virtual-row corrections.
    const css = read('theme/scroll-depth.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/animation|scale|opacity|transform/);
  });
  it('keeps one shared scroll-depth entry point in app and harnesses', () => {
    for (const entry of ['main.tsx','gallery.tsx','chatLab.tsx','polishLab.tsx']) {
      expect(read(entry)).toContain("import './theme/scroll-depth.css';");
    }
  });
  it('only the follower writes the bottom position; measurement anchors above readers', () => {
    const thread = read('components/Thread.tsx');
    expect(thread).toContain('!props.followingEnd?.current && item.end <= (instance.scrollOffset ?? 0)');
  });
});
