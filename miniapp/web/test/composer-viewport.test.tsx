import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useComposerSizing } from '../src/hooks/useComposerSizing';
import { useDockHeight } from '../src/hooks/useDockHeight';
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('typing owns its visible viewport', () => {
  it('reveals the end of a long draft after autosizing and keyboard resizes', () => {
    let resize!: ResizeObserverCallback;
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect() {} });
    const field = document.createElement('textarea'); document.body.append(field);
    field.value = 'A long draft with many wrapped lines.'; field.focus(); field.setSelectionRange(field.value.length, field.value.length);
    Object.defineProperties(field, { scrollHeight: { value: 700, configurable: true }, clientHeight: { value: 100, configurable: true } });
    renderHook(() => useComposerSizing({ current: field }, field.value));
    expect(field.style.height).toBe('180px'); expect(field.scrollTop).toBe(700);
    field.scrollTop = 0;
    act(() => resize([], {} as ResizeObserver));
    expect(field.scrollTop).toBe(700);
  });
  it('does not force the end when editing an earlier line', () => {
    const field = document.createElement('textarea'); document.body.append(field);
    field.value = 'First line\nAnother line\nLast line'; field.focus(); field.setSelectionRange(2, 2);
    Object.defineProperties(field, { scrollHeight: { value: 700 }, clientHeight: { value: 100 }, clientWidth: { value: 280 } });
    renderHook(() => useComposerSizing({ current: field }, field.value));
    expect(field.scrollTop).toBe(0);
    expect(document.querySelector<HTMLDivElement>('[aria-hidden="true"]')?.inert).toBe(true);
    cleanup(); expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });
  it('publishes a real dock budget below the header and recomputes on resize', () => {
    let resize!: ResizeObserverCallback;
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect() {} });
    const host = document.createElement('div'); const header = document.createElement('header'); header.className = 'thread-header';
    const dock = document.createElement('footer'); host.append(header, dock); document.body.append(host);
    let bottom = 500;
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({ bottom } as DOMRect));
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ bottom: 64 } as DOMRect);
    vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue({ height: 320 } as DOMRect);
    renderHook(() => useDockHeight({ current: host }, { current: dock }));
    expect(host.style.getPropertyValue('--dock-max-h')).toBe('428px');
    bottom = 400; act(() => resize([], {} as ResizeObserver));
    expect(host.style.getPropertyValue('--dock-max-h')).toBe('328px');
  });
});
