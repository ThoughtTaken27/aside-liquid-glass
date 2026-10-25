import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { useRestingFocus } from '../src/hooks/useRestingFocus';

function Home({ atRest, enabled = true }: { atRest: boolean; enabled?: boolean }) {
  const dock = useRef<HTMLElement>(null);
  useRestingFocus(dock, atRest, enabled);
  return <><button>elsewhere</button><footer ref={dock}><textarea className="composer-input" aria-label="composer" /></footer></>;
}
const box = () => document.querySelector('.composer-input') as HTMLTextAreaElement;
const visibility = (v: 'visible' | 'hidden') => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: v }); document.dispatchEvent(new Event('visibilitychange')); };

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(document, 'hasFocus').mockReturnValue(true); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('opening Aside lands in the composer', () => {
  it('focuses the Home composer on launch', () => {
    render(<Home atRest />);
    expect(document.activeElement).not.toBe(box());
    act(() => vi.advanceTimersByTime(120));
    expect(document.activeElement).toBe(box());
  });
  it('focuses it again when the app comes back to the screen', () => {
    render(<Home atRest />);
    act(() => vi.advanceTimersByTime(120));
    box().blur();
    visibility('hidden'); visibility('visible');
    act(() => vi.advanceTimersByTime(120));
    expect(document.activeElement).toBe(box());
  });
  it('waits for the window to get input focus before raising the keyboard', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    render(<Home atRest />);
    act(() => vi.advanceTimersByTime(120));
    expect(document.activeElement).not.toBe(box());
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(document.activeElement).toBe(box());
  });
  it('leaves Recents, other screens, and a field you were in alone', () => {
    const { rerender } = render(<Home atRest={false} />);
    act(() => vi.advanceTimersByTime(500));
    expect(document.activeElement).toBe(document.body);
    (document.querySelector('button') as HTMLButtonElement).focus();
    rerender(<Home atRest />);
    act(() => vi.advanceTimersByTime(500));
    expect(document.activeElement?.tagName).toBe('BUTTON');
  });
  it('drops a pending focus when a thread opens before it fires', () => {
    const { rerender } = render(<Home atRest />);
    rerender(<Home atRest={false} />);
    act(() => vi.advanceTimersByTime(500));
    expect(document.activeElement).toBe(document.body);
  });
  it('does nothing outside the installed app', () => {
    render(<Home atRest enabled={false} />);
    act(() => vi.advanceTimersByTime(500));
    expect(document.activeElement).toBe(document.body);
  });
});
