import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModeSwitch } from '../src/components/ModeSwitch';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(web, 'src/theme/refine.css'), 'utf8');
const curated = css.slice(css.indexOf('/* Curated controls:'));
const entry = (name: string) => readFileSync(path.join(web, 'src', name), 'utf8');
const styles = (source: string) => [...source.matchAll(/import '(\.\/theme\/[^']+)';/g)].map((m) => m[1]);

afterEach(cleanup);

describe('curated phone controls', () => {
  it('keeps gallery and question fixtures on the live stylesheet stack', () => {
    expect(styles(entry('gallery.tsx'))).toEqual(styles(entry('main.tsx')));
    expect(styles(entry('polishLab.tsx'))).toEqual(styles(entry('main.tsx')));
  });

  it('scopes every new style rule to standalone rather than Telegram or Next', () => {
    const selectors = [...curated.matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim())
      .filter((s) => s && !s.startsWith('@media'));
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) expect(selector).toContain(":root[data-client='standalone']");
  });

  it('uses actual 44px control boxes, not overlapping pseudo-element hit slop', () => {
    expect(curated).toContain('.mode-switch-option {\n  height: 44px;\n  min-height: 44px;');
    expect(curated).toContain('.mode-switch-option::before { content: none; }');
    expect(css).toMatch(/\.round-button\.send \{\s+width: 44px;\s+height: 44px;/);
    expect(css).toMatch(/\.question-reply :is\(\.question-send, \.question-skip\) \{[^}]*height: 44px;/);
  });

  it('keeps the most specific send and question rules still under reduced motion', () => {
    const finalReduce = curated.slice(curated.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(finalReduce).toContain('.composer .round-button.send,');
    expect(finalReduce).toContain('.question-card .question-option,');
    expect(finalReduce).toContain('transition: none;');
    expect(finalReduce).toContain('.question-option:active:not(:disabled)');
    expect(finalReduce).toContain('transform: none;');
  });

  it('adds no new blur animation, layout animation, or perpetual animation', () => {
    expect(curated).not.toMatch(/(?:filter|width|height|left|top|all)\s+\d+(?:ms|s)/);
    expect(curated).not.toContain('infinite');
    expect(curated).not.toContain('@keyframes');
  });

  it('preserves accessible mode selection and the existing callback', () => {
    const change = vi.fn();
    const { rerender } = render(<ModeSwitch mode="chat" onChange={change} />);
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Web' }));
    expect(change).toHaveBeenCalledExactlyOnceWith('search');
    rerender(<ModeSwitch mode="search" onChange={change} />);
    expect(screen.getByRole('button', { name: 'Web' }).getAttribute('aria-pressed')).toBe('true');
  });
});
