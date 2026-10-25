import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const load = vi.hoisted(() => ({ resolve: undefined as undefined | ((v: { Markdown: () => React.ReactNode }) => void) }));
vi.mock('../src/components/Markdown', () => new Promise((resolve) => { load.resolve = resolve; }));
import { Markdown, MARKDOWN_WAIT_MS } from '../src/components/MarkdownAsync';
afterEach(()=>{cleanup();vi.useRealTimers()});
describe('a stalled renderer does not strand the chat or reflow later',()=>{
  it('makes plain text readable once, then ignores a late typography upgrade',async()=>{
    vi.useFakeTimers();
    const {container,rerender}=render(<Markdown text="Saved readable answer" />);
    expect(container.querySelector('.md-pending')).not.toBeNull();
    await act(async()=>{await vi.advanceTimersByTimeAsync(MARKDOWN_WAIT_MS)});
    expect(container.querySelector('.md-pending')).toBeNull();
    expect(container.querySelector('.md-format-unavailable')?.textContent).toBe('Saved readable answer');
    await act(async()=>{load.resolve?.({Markdown:()=> <h1>Different layout</h1>})});
    expect(container.querySelector('h1')).toBeNull();
    rerender(<Markdown text="Saved readable answer with new text" />);
    expect(container.textContent).toBe('Saved readable answer with new text');
  });
});
