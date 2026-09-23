/**
 * The swipe row's release contract: direction decides a flick, position
 * decides a drag, and a second finger never steers.
 *
 * A slow drag past 45% of the action width opens; anything short of that
 * springs back -- unless the finger was moving fast, in which case a left
 * throw opens from anywhere and a right throw closes an open row. Tap
 * jitter (fast but tiny) must never qualify as a flick.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { SwipeToDelete } from '../src/components/SwipeToDelete';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function touch(identifier: number, clientX: number, clientY: number) {
  return { identifier, clientX, clientY, target: document.body };
}

function renderRow() {
  const onDelete = vi.fn();
  const view = render(
    <SwipeToDelete label="Delete" onDelete={onDelete}>
      <button type="button">Row</button>
    </SwipeToDelete>,
  );
  const surface = view.container.querySelector<HTMLElement>('.swipe-surface')!;
  return { ...view, surface, onDelete };
}

/** A movable clock, same pattern as sheet.test.tsx. */
function mockClock() {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  return {
    advance(ms: number) {
      clock += ms;
    },
  };
}

function startAt(surface: HTMLElement, x: number, id = 0) {
  const t = touch(id, x, 50);
  fireEvent.touchStart(surface, { touches: [t], changedTouches: [t] });
}

function moveTo(surface: HTMLElement, x: number, id = 0) {
  const t = touch(id, x, 50);
  fireEvent.touchMove(surface, { touches: [t], changedTouches: [t] });
}

function endAt(surface: HTMLElement, x: number, id = 0) {
  const t = touch(id, x, 50);
  fireEvent.touchEnd(surface, { touches: [], changedTouches: [t] });
}

describe('the swipe row release', () => {
  it('opens on a fast flick left, short of the threshold', () => {
    // 30px of travel -- under the ~40px threshold -- but at 1px/ms,
    // which is a deliberate throw, not a drag.
    const clock = mockClock();
    const { surface } = renderRow();
    startAt(surface, 100);
    clock.advance(30);
    moveTo(surface, 70);
    endAt(surface, 70);
    expect(surface.style.transform).toBe('translate3d(-88px, 0, 0)');
  });

  it('closes on a fast flick right, even from past the threshold', () => {
    // Open it slowly first (position decides), then throw right: 48px of
    // offset remains, but the velocity direction wins and it closes.
    const clock = mockClock();
    const { surface } = renderRow();
    startAt(surface, 100);
    clock.advance(400);
    moveTo(surface, 50);
    endAt(surface, 50);
    expect(surface.style.transform).toBe('translate3d(-88px, 0, 0)');

    startAt(surface, 60);
    clock.advance(16);
    moveTo(surface, 100);
    endAt(surface, 100);
    expect(surface.style.transform).toBe('translate3d(0px, 0, 0)');
  });

  it('ignores a fast but tiny jitter as a flick', () => {
    // 10px in 5ms is 2px/ms -- very fast, and still just a tap wobble.
    // Below the travel floor, position decides, and 10px springs back.
    const clock = mockClock();
    const { surface } = renderRow();
    startAt(surface, 100);
    clock.advance(5);
    moveTo(surface, 90);
    endAt(surface, 90);
    expect(surface.style.transform).toBe('translate3d(0px, 0, 0)');
  });

  it('lets position decide once the finger has stopped', () => {
    // Past the threshold but released 200ms after the last move: the
    // velocity is stale, so this is a hold-and-release, not a throw.
    // (It still opens -- on position, which is the point.)
    const clock = mockClock();
    const { surface } = renderRow();
    startAt(surface, 100);
    clock.advance(300);
    moveTo(surface, 55);
    clock.advance(200);
    endAt(surface, 55);
    expect(surface.style.transform).toBe('translate3d(-88px, 0, 0)');
  });

  it('ignores a second finger for the whole gesture', () => {
    // Finger 1 lands mid-drag and waves around; only finger 0 steers,
    // and only finger 0 lifting ends the gesture.
    const clock = mockClock();
    const { surface } = renderRow();
    startAt(surface, 100, 0);
    clock.advance(300);
    moveTo(surface, 60, 0);
    startAt(surface, 50, 1);
    moveTo(surface, 0, 1);
    expect(surface.style.transform).toBe('translate3d(-40px, 0, 0)');
    endAt(surface, 0, 1);
    // Still tracking finger 0: releasing finger 1 changed nothing.
    clock.advance(300);
    endAt(surface, 60, 0);
    expect(surface.style.transform).toBe('translate3d(-88px, 0, 0)');
  });
});
