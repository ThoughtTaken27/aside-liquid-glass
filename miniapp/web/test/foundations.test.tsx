import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ModeSwitch } from '../src/components/ModeSwitch';

vi.mock('../src/telegram', () => ({ haptic: vi.fn() }));
afterEach(cleanup);

function ModeFixture() {
  const [mode, setMode] = useState<'chat' | 'search'>('chat');
  return <ModeSwitch mode={mode} onChange={setMode} />;
}

describe('TypeUI foundation control invariants', () => {
  it('keeps both control nodes and the one selection node through a change', () => {
    const { container } = render(<ModeFixture />);
    const chat = screen.getByRole('button', { name: 'Chat' });
    const web = screen.getByRole('button', { name: 'Web' });
    const selection = container.querySelector('.mode-switch-selection');
    fireEvent.click(web);
    expect(web.getAttribute('aria-pressed')).toBe('true');
    expect(chat.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Chat' })).toBe(chat);
    expect(screen.getByRole('button', { name: 'Web' })).toBe(web);
    expect(container.querySelector('.mode-switch-selection')).toBe(selection);
  });
  it('marks keyboard interaction for instant selection, then restores pointer motion', () => {
    render(<ModeFixture />);
    const web = screen.getByRole('button', { name: 'Web' });
    const group = screen.getByRole('group', { name: 'Chat or web search' });
    fireEvent.keyDown(web, { key: 'Enter' });
    fireEvent.click(web, { detail: 0 });
    expect(group.getAttribute('data-keyboard')).toBe('true');
    expect(group.getAttribute('data-mode')).toBe('search');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Chat' }));
    expect(group.hasAttribute('data-keyboard')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }), { detail: 1 });
    expect(group.getAttribute('data-mode')).toBe('chat');
  });
  it('does not dispatch an action for the already-selected mode', () => {
    const change = vi.fn();
    render(<ModeSwitch mode="chat" onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Web' }));
    expect(change).toHaveBeenCalledExactlyOnceWith('search');
  });
  it('keeps target/focus corrections in the order-proof standalone system', () => {
    const css = readFileSync('src/theme/system.css', 'utf8');
    const foundation = css.slice(css.indexOf('/* 13. TypeUI'));
    expect(foundation).toContain("[data-client='standalone']");
    expect(foundation).toContain('--foundation-target: 44px');
    expect(foundation).toContain('outline: 2px solid var(--foreground)');
    expect(foundation).toContain('@media (forced-colors: active)');
    expect(foundation).toContain('@media (prefers-reduced-motion: reduce)');
    expect(foundation).toContain('.mode-switch[data-keyboard] .mode-switch-selection { transition: none; }');
    expect(foundation).not.toMatch(/transition:[^;]*(?:all|font-weight|width)/);
  });
  it('limits touch sizing to real controls and preserves reading-text wrapping', () => {
    const css = readFileSync('src/theme/system.css', 'utf8');
    const foundation = css.slice(css.indexOf('/* 13. TypeUI'));
    expect(foundation).toContain('@media (max-width: 600px), (pointer: coarse)');
    expect(foundation).toContain('.cq-custom input { font-size: 16px; line-height: 1.5; }');
    expect(foundation).toContain('.code-fence-copy');
    expect(foundation).not.toContain('text-wrap: balance');
    expect(foundation).not.toMatch(/\.md\s*\{[^}]*text-wrap/);
  });
});
