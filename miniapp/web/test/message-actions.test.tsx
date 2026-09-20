/**
 * The copy button.
 *
 * The interesting case is not the happy path, it is the failure: a webview
 * can refuse both clipboard routes, and the button must say so rather than
 * flash a checkmark over text that never left the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageActions } from '../src/components/MessageActions';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Replace `navigator.clipboard` for one test. */
function stubClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

describe('copying a message', () => {
  it('puts the exact text on the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    // Braces, not a plain attribute: in JSX `"a\nb"` is a literal
    // backslash and an n, which would make this assert the wrong thing.
    const markdown = '# Heading\n\nBody text.';
    render(<MessageActions text={markdown} />);
    fireEvent.click(screen.getByLabelText('Copy'));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));
  });

  it('confirms in the label, not just the icon', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));

    render(<MessageActions text="hello" />);
    expect(screen.getByText('Copy')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Copy'));
    await vi.waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
  });

  it('says Failed rather than claiming a copy that did not happen', async () => {
    // Both routes refuse: the async API rejects, and jsdom has no
    // execCommand, so the fallback throws too.
    stubClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')));

    render(<MessageActions text="hello" />);
    fireEvent.click(screen.getByLabelText('Copy'));

    await vi.waitFor(() => expect(screen.getByText('Failed')).toBeTruthy());
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('falls back to execCommand when the async API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const exec = vi.fn().mockReturnValue(true);
    // @ts-expect-error -- jsdom does not implement it
    document.execCommand = exec;

    render(<MessageActions text="hello" />);
    fireEvent.click(screen.getByLabelText('Copy'));

    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('copy'));
    await vi.waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
  });

  it('renders nothing at all for an empty message', () => {
    const { container } = render(<MessageActions text="   " />);
    expect(container.firstChild).toBeNull();
  });

  it('hangs the row on the requested side', () => {
    const { container } = render(<MessageActions text="hi" align="end" />);
    expect(
      (container.firstChild as HTMLElement).className,
    ).toContain('is-end');
  });
});
