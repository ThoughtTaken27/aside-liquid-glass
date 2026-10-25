/**
 * A long user message is clamped, and clamping never destroys content.
 *
 * The rule these lock in: the toggle is offered only when the text
 * actually overflows, the full message is always present in the DOM (so
 * copy, find-in-page and screen readers still see all of it), and the
 * clamp is applied by default rather than after a measurement -- which is
 * the only order in which `scrollHeight > clientHeight` can ever be true.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UserBubble } from '../src/components/Thread';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LONG = Array.from(
  { length: 40 },
  (_, index) => `Sentence number ${index} of a pasted brief.`,
).join(' ');

const SHORT = 'Fix this, please.';

/**
 * jsdom reports every element as zero-sized, so overflow has to be faked.
 * `overflowing` decides what `scrollHeight` reports back; `clientHeight`
 * stays at zero, which is jsdom's own answer.
 */
function stubOverflow(overflowing: boolean) {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      if (!(this as HTMLElement).classList.contains('user-bubble-body')) {
        return 0;
      }
      return overflowing ? 400 : 0;
    },
  });
}

function renderThread(text: string) {
  return render(<UserBubble text={text} />);
}

describe('user bubble clamp', () => {
  it('offers a toggle and keeps the whole message when the text overflows', () => {
    stubOverflow(true);
    const { container } = renderThread(LONG);

    const body = container.querySelector('.user-bubble-body');
    expect(body).toBeTruthy();
    // Nothing is truncated in the DOM; the clamp is presentational.
    expect(body?.textContent).toBe(LONG);
    expect(body?.getAttribute('data-clamped')).toBe('true');

    const toggle = screen.getByRole('button', { name: 'Show more' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(
      container.querySelector('.user-bubble-body')?.getAttribute('data-clamped'),
    ).toBe('false');
    expect(
      screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(container.querySelector('.user-bubble-body')?.textContent).toBe(LONG);
  });

  it('shows no toggle for a message that fits', () => {
    stubOverflow(false);
    const { container } = renderThread(SHORT);

    expect(container.querySelector('.user-bubble-body')?.textContent).toBe(SHORT);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(container.querySelector('.user-bubble.is-clamped')).toBeNull();
  });
});
