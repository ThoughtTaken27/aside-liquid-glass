/**
 * Press and hold to reveal a message's actions.
 *
 * Every assertion here is a way the gesture can go wrong in the hand, not
 * a rendering detail: firing on a tap, firing during a scroll, two rows
 * open at once, or a row that will not go away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PressReveal } from '../src/components/PressReveal';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** Hold a node down at a point, without releasing. */
function touchDown(node: Element, x = 0, y = 0) {
  fireEvent.touchStart(node, { touches: [{ clientX: x, clientY: y }] });
}

function touchMoveTo(node: Element, x: number, y: number) {
  fireEvent.touchMove(node, { touches: [{ clientX: x, clientY: y }] });
}

/** Advance past the hold threshold. */
function waitOutTheHold() {
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

describe('press and hold', () => {
  it('shows nothing until the hold completes', () => {
    const { container } = render(
      <PressReveal text="hello">
        <p>message</p>
      </PressReveal>,
    );
    const host = container.firstChild as Element;

    expect(screen.queryByLabelText('Copy')).toBeNull();

    touchDown(host);
    // Halfway through the hold: still nothing.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByLabelText('Copy')).toBeNull();

    waitOutTheHold();
    expect(screen.getByLabelText('Copy')).toBeTruthy();
  });

  it('does not fire on an ordinary tap', () => {
    const { container } = render(
      <PressReveal text="hello">
        <p>message</p>
      </PressReveal>,
    );
    const host = container.firstChild as Element;

    touchDown(host);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    fireEvent.touchEnd(host);
    waitOutTheHold();

    expect(screen.queryByLabelText('Copy')).toBeNull();
  });

  it('cancels when the finger is actually scrolling', () => {
    const { container } = render(
      <PressReveal text="hello">
        <p>message</p>
      </PressReveal>,
    );
    const host = container.firstChild as Element;

    touchDown(host, 100, 100);
    // Well past the 10px slop: this is a scroll, not a hold.
    touchMoveTo(host, 104, 160);
    waitOutTheHold();

    expect(screen.queryByLabelText('Copy')).toBeNull();
  });

  it('tolerates the small drift of a finger holding still', () => {
    const { container } = render(
      <PressReveal text="hello">
        <p>message</p>
      </PressReveal>,
    );
    const host = container.firstChild as Element;

    touchDown(host, 100, 100);
    touchMoveTo(host, 103, 104);
    waitOutTheHold();

    expect(screen.getByLabelText('Copy')).toBeTruthy();
  });

  it('closes when something outside is touched', () => {
    const { container } = render(
      <div>
        <PressReveal text="hello">
          <p>message</p>
        </PressReveal>
        <button type="button">elsewhere</button>
      </div>,
    );
    const host = container.querySelector('.press-reveal')!;

    touchDown(host);
    waitOutTheHold();
    expect(screen.getByLabelText('Copy')).toBeTruthy();

    act(() => {
      fireEvent.pointerDown(screen.getByText('elsewhere'));
    });
    expect(screen.queryByLabelText('Copy')).toBeNull();
  });

  it('closes on scroll', () => {
    const { container } = render(
      <PressReveal text="hello">
        <p>message</p>
      </PressReveal>,
    );
    const host = container.firstChild as Element;

    touchDown(host);
    waitOutTheHold();
    expect(screen.getByLabelText('Copy')).toBeTruthy();

    act(() => {
      fireEvent.scroll(window);
    });
    expect(screen.queryByLabelText('Copy')).toBeNull();
  });

  it('keeps only one message open at a time', () => {
    const { container } = render(
      <div>
        <PressReveal text="first">
          <p>one</p>
        </PressReveal>
        <PressReveal text="second">
          <p>two</p>
        </PressReveal>
      </div>,
    );
    const [a, b] = Array.from(container.querySelectorAll('.press-reveal'));

    touchDown(a);
    waitOutTheHold();
    expect(screen.getAllByLabelText('Copy')).toHaveLength(1);

    act(() => {
      touchDown(b);
    });
    waitOutTheHold();
    expect(screen.getAllByLabelText('Copy')).toHaveLength(1);
  });

  it('attaches no gesture at all when disabled', () => {
    const { container } = render(
      <PressReveal text="hello" enabled={false}>
        <p>streaming…</p>
      </PressReveal>,
    );
    const host = container.firstChild as Element;

    touchDown(host);
    waitOutTheHold();
    expect(screen.queryByLabelText('Copy')).toBeNull();
  });

  it('opens on right-click, the desktop form of the same intent', () => {
    const { container } = render(
      <PressReveal text="hello">
        <p>message</p>
      </PressReveal>,
    );
    const host = container.firstChild as Element;

    act(() => {
      fireEvent.contextMenu(host);
    });
    expect(screen.getByLabelText('Copy')).toBeTruthy();
  });
});
