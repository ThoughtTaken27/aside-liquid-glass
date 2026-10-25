import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModeSwitch } from '../src/components/ModeSwitch';
import type { ComposerMode } from '../src/components/Composer';

function SwitchHarness() {
  const [mode, setMode] = useState<ComposerMode>('chat');
  return <ModeSwitch mode={mode} onChange={setMode} />;
}

describe('Libraries.dev motion integration', () => {
  it('keeps the Chat/Web control real and accessible above the liquid layer', () => {
    const { container } = render(<SwitchHarness />);
    const chat = screen.getByRole('button', { name: 'Chat' });
    const web = screen.getByRole('button', { name: 'Web' });

    expect(chat.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.mode-switch-liquid-layer')).toBeTruthy();
    expect(container.querySelector('[data-gooey-svg]')).toBeTruthy();

    fireEvent.click(web);

    expect(web.getAttribute('aria-pressed')).toBe('true');
    expect(chat.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('.mode-switch')?.getAttribute('data-mode')).toBe('search');
  });
});
