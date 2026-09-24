/**
 * Interaction polish that has to stay honest.
 *
 * These are the controls a thumb actually meets: a code fence you can take,
 * a search toggle that shows it is open, and Enter that does not send while
 * an IME is still confirming a character.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown';
import { SessionList } from '../src/components/SessionList';
import { Composer } from '../src/components/Composer';
import { PairPrompt } from '../src/components/PairPrompt';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function composerProps(overrides: Record<string, unknown> = {}) {
  return {
    variant: 'reply' as const,
    value: 'hello',
    onChange: () => {},
    onSubmit: () => {},
    pills: { modelLabel: 'Sonnet', effortLabel: 'High', effortId: 'high' },
    onOpenModel: () => {},
    attachments: [],
    onAddFiles: () => {},
    onRemoveAttachment: () => {},
    ...overrides,
  };
}

describe('code fences', () => {
  it('labels the language and offers a copy control', () => {
    render(<Markdown text={'```ts\nconst n = 1;\n```'} />);
    expect(screen.getByText('ts')).toBeTruthy();
    expect(screen.getByLabelText('Copy code')).toBeTruthy();
    expect(screen.getByText('const n = 1;')).toBeTruthy();
  });

  it('still copies a fence this app cannot highlight', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    render(<Markdown text={'```rust\nfn main() {}\n```'} />);
    expect(screen.getByText('rust')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Copy code'));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('fn main() {}'));
    await vi.waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
  });
});

describe('history controls', () => {
  it('shows search as open, and names the sort direction', () => {
    render(<SessionList sessions={[]} onOpen={() => {}} loading={false} />);
    const search = screen.getByLabelText('Search sessions');
    expect(search.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(search);
    expect(search.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Search chats and actions')).toBeTruthy();

    const sort = screen.getByLabelText('Show oldest first');
    expect(sort.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(sort);
    expect(screen.getByLabelText('Show newest first').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('composer IME', () => {
  it('does not send while a composition is confirming', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('pointer: fine'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    const onSubmit = vi.fn();
    render(<Composer {...composerProps({ onSubmit })} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    // @ts-expect-error -- restoring the jsdom default from test/setup.ts
    delete window.matchMedia;
  });
});

describe('pairing paste', () => {
  it('fills the field from the clipboard and says when the text is not a code', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn().mockResolvedValue('not a code') },
      configurable: true,
      writable: true,
    });
    render(<PairPrompt onPaired={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    await vi.waitFor(() =>
      expect(screen.getByLabelText('Pairing link or key')).toHaveProperty('value', 'not a code'),
    );
    expect(screen.getByText(/doesn’t look like a pairing link/)).toBeTruthy();
  });
});
