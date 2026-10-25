import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { useDockFocus } from '../src/hooks/useDockFocus';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function Dock() {
  const ref = useRef<HTMLElement>(null);
  useDockFocus(ref);
  return <><footer ref={ref}><textarea aria-label="draft"/><button>model</button></footer><button>outside</button></>;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('stable Home focus presentation', () => {
  it('tracks element focus without depending on browser-window CSS focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { container, getByRole } = render(<Dock />);
    const dock = container.querySelector('footer')!;
    getByRole('textbox').focus();
    expect(dock.hasAttribute('data-composer-focused')).toBe(true);
    fireEvent(window, new Event('blur'));
    expect(dock.hasAttribute('data-composer-focused')).toBe(true);
    getByRole('button', { name: 'model' }).focus();
    expect(dock.hasAttribute('data-composer-focused')).toBe(true);
    getByRole('button', { name: 'outside' }).focus();
    expect(dock.hasAttribute('data-composer-focused')).toBe(false);
  });
  it('does not reposition when the window backgrounds with no next focus target', () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { container, getByRole } = render(<Dock />);
    getByRole('textbox').focus();
    focused.mockReturnValue(false);
    fireEvent.focusOut(container.querySelector('footer')!, { relatedTarget: null });
    expect(container.querySelector('footer')?.hasAttribute('data-composer-focused')).toBe(true);
  });
  it('reserves the cue slot and reconciles the effective handoff speed', () => {
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/theme/components.css'), 'utf8');
    expect(css).not.toContain('margin-bottom: -44px');
    expect(css).not.toContain('.home-dock:focus-within');
    expect(css).not.toContain('transition: transform 210ms');
    expect(css).toContain('.home-dock[data-composer-focused]');
  });
});
