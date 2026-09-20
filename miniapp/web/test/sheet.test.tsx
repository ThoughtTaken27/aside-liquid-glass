/**
 * The bottom sheet's grab handle is a promise, and this is the proof it
 * is kept.
 *
 * Drawing a handle over a sheet that cannot be dragged is the specific
 * detail that makes an app feel like a mock-up, so the gesture is real --
 * and a real gesture has edges worth pinning down: a tap must not throw
 * the sheet away, a slow nudge must spring back, and a flick must not be
 * rejected just because it was short.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sheet } from '../src/components/Sheet';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSheet(onClose = vi.fn(), side: 'bottom' | 'right' = 'bottom') {
  const view = render(
    <Sheet side={side} title="Select model" onClose={onClose}>
      <p>body</p>
    </Sheet>,
  );
  return { ...view, onClose };
}

/**
 * Runs one drag on the sheet head with a controlled duration.
 *
 * A movable clock rather than a queue of return values. Queueing two
 * results looks tidier and is wrong here: `fireEvent` runs inside `act`,
 * React's scheduler reads `performance.now` on its own account, and those
 * reads silently eat the queue -- so the component saw a real timestamp
 * where it expected 0 and every flick computed as glacial.
 */
function drag(head: HTMLElement, distance: number, ms: number) {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  fireEvent.pointerDown(head, { clientY: 0, pointerId: 1, button: 0 });
  clock = ms;
  fireEvent.pointerMove(head, { clientY: distance, pointerId: 1 });
  fireEvent.pointerUp(head, { clientY: distance, pointerId: 1 });
}

describe('the bottom sheet drags to dismiss', () => {
  it('follows the finger downward while held', () => {
    const { container } = renderSheet();
    const head = container.querySelector<HTMLElement>('.sheet-head')!;
    fireEvent.pointerDown(head, { clientY: 0, pointerId: 1, button: 0 });
    fireEvent.pointerMove(head, { clientY: 60, pointerId: 1 });

    const sheet = container.querySelector<HTMLElement>('.sheet')!;
    expect(sheet.style.transform).toBe('translate3d(0, 60px, 0)');
    expect(sheet.className).toContain('is-dragging');
  });

  it('refuses to be lifted off the bottom of the screen', () => {
    // Following a finger UP would expose a strip of backdrop underneath,
    // which no sheet on any platform does.
    const { container } = renderSheet();
    const head = container.querySelector<HTMLElement>('.sheet-head')!;
    fireEvent.pointerDown(head, { clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(head, { clientY: 20, pointerId: 1 });
    expect(container.querySelector<HTMLElement>('.sheet')!.style.transform).toBe('');
  });

  it('survives a tap with a few pixels of jitter', () => {
    // 4px over 6ms is 0.67px/ms -- comfortably past the flick threshold.
    // Velocity alone would read an ordinary tap on the header as a throw
    // and dismiss the sheet, which is why travel has a floor.
    const { container, onClose } = renderSheet();
    drag(container.querySelector<HTMLElement>('.sheet-head')!, 4, 6);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('springs back from a short, slow drag', () => {
    const { container, onClose } = renderSheet();
    drag(container.querySelector<HTMLElement>('.sheet-head')!, 60, 400);
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>('.sheet')!.style.transform).toBe('');
  });

  it('dismisses on a short but fast flick', () => {
    const { container, onClose } = renderSheet();
    drag(container.querySelector<HTMLElement>('.sheet-head')!, 60, 60);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses on a long drag however slow', () => {
    const { container, onClose } = renderSheet();
    drag(container.querySelector<HTMLElement>('.sheet-head')!, 140, 2000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a drag that began on a control in the head', () => {
    // The back arrow lives in the header. A press that starts on it is a
    // tap on that button, not the beginning of a throw.
    const onBack = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <Sheet side="bottom" title="Reasoning" onBack={onBack} onClose={onClose}>
        <p>body</p>
      </Sheet>,
    );
    const back = screen.getByRole('button', { name: 'Back' });
    fireEvent.pointerDown(back, { clientY: 0, pointerId: 1, button: 0 });
    fireEvent.pointerMove(container.querySelector('.sheet-head')!, {
      clientY: 200,
      pointerId: 1,
    });
    expect(container.querySelector<HTMLElement>('.sheet')!.style.transform).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('the two sides get different heads on purpose', () => {
  it('a bottom sheet has a grip and no close button', () => {
    const { container } = renderSheet();
    expect(container.querySelector('.sheet-grip')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('a right panel keeps its close button and gets no grip', () => {
    // It cannot be flicked down, so a handle there would promise a
    // gesture that does not exist.
    const { container } = renderSheet(vi.fn(), 'right');
    expect(container.querySelector('.sheet-grip')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('names the back arrow by where it returns to', () => {
    render(
      <Sheet
        side="bottom"
        title="Reasoning"
        onBack={vi.fn()}
        backLabel="model"
        onClose={vi.fn()}
      >
        <p>body</p>
      </Sheet>,
    );
    expect(screen.getByRole('button', { name: 'Back to model' })).toBeTruthy();
  });
});
