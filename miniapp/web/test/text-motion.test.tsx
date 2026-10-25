import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RollText, Shine, TextReveal } from '../src/components/Affect';

let reduce = false;
let hidden = false;
let intersection: IntersectionObserverCallback;
let disconnect: ReturnType<typeof vi.fn>;
let listeners: Set<() => void>;
let animate: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reduce = false; hidden = false; listeners = new Set();
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    get matches() { return reduce; }, media: query, onchange: null,
    addEventListener: (_: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener as () => void),
    removeEventListener: (_: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener as () => void),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  } as MediaQueryList));
  disconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersection = callback; }
    observe() {} unobserve() {} disconnect = disconnect;
  });
  cancel = vi.fn(); animate = vi.fn(() => ({ cancel }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as Partial<HTMLElement>).animate; });
const inView = (value: boolean) => act(() => intersection([{ isIntersecting: value } as IntersectionObserverEntry], {} as IntersectionObserver));

describe('calm work-label motion', () => {
  it('keeps a readable base and hides the decorative copy from accessibility', () => {
    const { container } = render(<Shine text="Reading sources" />);
    expect(container.querySelector('.af-shine')?.firstChild?.textContent).toBe('Reading sources');
    expect(container.querySelector('.af-shine-window')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.af-shine')?.getAttribute('aria-busy')).toBeNull();
  });
  it('runs only while active, visible and onscreen, and cleans up observers', () => {
    const { container, rerender, unmount } = render(<Shine text="Reading" />);
    const host = container.querySelector('.af-shine')!;
    expect(host.classList.contains('is-running')).toBe(false);
    inView(true); expect(host.classList.contains('is-running')).toBe(true);
    act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    expect(host.classList.contains('is-running')).toBe(false);
    act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    expect(host.classList.contains('is-running')).toBe(true);
    inView(false); expect(host.classList.contains('is-running')).toBe(false);
    rerender(<Shine text="Done" active={false} />);
    expect(host.classList.contains('is-running')).toBe(false);
    unmount(); expect(disconnect).toHaveBeenCalled(); expect(listeners.size).toBe(0);
  });
  it('stops immediately when Reduce Motion changes without hiding the label', () => {
    const { container } = render(<Shine text="Reading" />); inView(true);
    act(() => { reduce = true; listeners.forEach(listener => listener()); });
    expect(container.querySelector('.is-running')).toBeNull();
    expect(container.querySelector('.af-shine')?.firstChild?.textContent).toBe('Reading');
  });
  it('preserves current node identity and removes the outgoing copy on completion', () => {
    const { container, rerender } = render(<RollText text="Reading the checklist" shine />);
    const current = container.querySelector('.is-current');
    rerender(<RollText text="Checking" shine />);
    expect(container.querySelector('.is-current')).toBe(current);
    expect(container.querySelector('.is-out')?.textContent).toBe('Reading the checklist');
    expect(animate).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(200));
    expect(container.querySelector('.is-out')).toBeNull();
  });
  it('coalesces bursts instead of replaying entrances or stacking copies', () => {
    const { container, rerender } = render(<RollText text="Reading" />);
    rerender(<RollText text="Comparing" />);
    act(() => vi.advanceTimersByTime(50));
    rerender(<RollText text="Done" />);
    expect(container.querySelector('.is-out')).toBeNull();
    expect(container.querySelector('.is-current')?.textContent).toBe('Done');
    expect(animate).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalled();
  });
  it('does not replay a change for identical text or animate reduced-motion updates', () => {
    const { container, rerender } = render(<RollText text="Reading" />);
    rerender(<RollText text="Reading" />); expect(animate).not.toHaveBeenCalled();
    reduce = true; rerender(<RollText text="Done" />);
    expect(animate).not.toHaveBeenCalled(); expect(container.querySelector('.is-out')).toBeNull();
  });
  it('cancels a running transition on unmount and on a live preference change', () => {
    const { rerender, unmount, container } = render(<RollText text="Reading" />);
    rerender(<RollText text="Comparing" />);
    act(() => { reduce = true; listeners.forEach(listener => listener()); });
    expect(cancel).toHaveBeenCalled(); expect(container.querySelector('.is-out')).toBeNull();
    unmount(); expect(listeners.size).toBe(0);
  });
  it('caps first-view word staggering rather than building a long delayed reveal', () => {
    const { container } = render(<TextReveal text={Array(40).fill('word').join(' ')} play />);
    const words = [...container.querySelectorAll<HTMLElement>('.af-reveal-w')];
    expect(words).toHaveLength(40);
    expect(Math.max(...words.map(word => Number(word.style.getPropertyValue('--i'))))).toBe(8);
  });
});
