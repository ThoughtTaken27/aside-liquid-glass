import { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePresenceItems, ITEM_EXIT_MS } from '../src/hooks/usePresenceItems';
import { AttachmentsTray } from '../src/components/AttachmentsTray';
import { Composer } from '../src/components/Composer';
import type { ComposerAttachment } from '../src/types';
const file = (key: string): ComposerAttachment => ({ key, name: key + '.pdf', mimeType: 'application/pdf', status: 'ready', path: key, size: 1024 });
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('presentation presence is not data ownership', () => {
  it('retains an exiting row but marks it logically absent immediately', () => {
    const a = file('a'), b = file('b');
    const { result, rerender } = renderHook(({ items }) => usePresenceItems(items, item => item.key), { initialProps: { items: [a, b] } });
    rerender({ items: [b] });
    expect(result.current.map(row => [row.key, row.present])).toEqual([['a', false], ['b', true]]);
    act(() => vi.advanceTimersByTime(ITEM_EXIT_MS));
    expect(result.current.map(row => row.key)).toEqual(['b']);
  });
  it('cancels stale removal when the same key returns during an exit', () => {
    const a = file('a');
    const { result, rerender } = renderHook(({ items }) => usePresenceItems(items, item => item.key), { initialProps: { items: [a] } });
    rerender({ items: [] }); act(() => vi.advanceTimersByTime(100));
    rerender({ items: [a] }); act(() => vi.advanceTimersByTime(400));
    expect(result.current).toHaveLength(1); expect(result.current[0].present).toBe(true);
  });
  it('settles initial data and only enters genuinely new rows', () => {
    const a = file('a'), b = file('b');
    const { result, rerender } = renderHook(({ items }) => usePresenceItems(items, item => item.key), { initialProps: { items: [a] } });
    expect(result.current[0].entering).toBe(false);
    rerender({ items: [a, b] }); expect(result.current[1].entering).toBe(true);
    act(() => vi.advanceTimersByTime(40)); expect(result.current[1].entering).toBe(false);
  });
  it('does not hold removed rows with reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { result, rerender } = renderHook(({ items }) => usePresenceItems(items, item => item.key), { initialProps: { items: [file('a')] } });
    rerender({ items: [] }); expect(result.current).toEqual([]);
  });
  it('unmount clears presentation timers and frames', () => {
    const { rerender, unmount } = renderHook(({ items }) => usePresenceItems(items, item => item.key), { initialProps: { items: [file('a')] } });
    rerender({ items: [] }); expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('retained DOM is inert and cannot remove twice', () => {
    const onRemove = vi.fn(), a = file('a'), b = file('b');
    const view = render(<AttachmentsTray items={[a, b]} onRemove={onRemove} />);
    const button = screen.getByRole('button', { name: 'Remove a.pdf' }); fireEvent.click(button);
    view.rerender(<AttachmentsTray items={[b]} onRemove={onRemove} />);
    expect(view.container.querySelector('[data-leaving]')?.hasAttribute('inert')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Remove a.pdf' })).toBeNull();
    fireEvent.click(button); expect(onRemove).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(ITEM_EXIT_MS)); expect(view.container.querySelector('[data-leaving]')).toBeNull();
  });
  it('shows a completion check only for an observed upload completion', () => {
    const a = file('a'), view = render(<AttachmentsTray items={[a]} onRemove={() => {}} />);
    expect(view.container.querySelector('.af-check')).toBeNull();
    view.rerender(<AttachmentsTray items={[{ ...a, status: 'uploading' }]} onRemove={() => {}} />);
    view.rerender(<AttachmentsTray items={[a]} onRemove={() => {}} />);
    expect(view.container.querySelector('.af-check.is-animated')).toBeTruthy();
    act(() => vi.advanceTimersByTime(901)); expect(view.container.querySelector('.af-check')).toBeNull();
    view.rerender(<AttachmentsTray items={[{ ...a }]} onRemove={() => {}} />);
    expect(view.container.querySelector('.af-check')).toBeNull();
  });
  it('submits current data, never the retained presentation of a removed file', () => {
    const sent = vi.fn();
    function Harness() {
      const [items, setItems] = useState([file('a'), file('b')]);
      return <Composer variant="reply" value="Send this" onChange={() => {}} onSubmit={() => sent(items.map(item => item.key))} pills={{ modelLabel: 'Example', effortLabel: 'High', effortId: 'high' }} onOpenModel={() => {}} attachments={items} onAddFiles={() => {}} onRemoveAttachment={key => setItems(previous => previous.filter(item => item.key !== key))} />;
    }
    const view = render(<Harness />); fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    expect(view.container.querySelector('[data-leaving]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' })); expect(sent).toHaveBeenCalledWith(['b']);
  });
});
