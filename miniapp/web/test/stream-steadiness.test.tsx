/**
 * Streaming steadiness: the fixes for the "frantic repositioning" a phone
 * reader saw while an answer was being written.
 *
 * Frame traces of a simulated turn (chat-lab `state=stream`) found four
 * causes, each locked in here by behaviour rather than wiring:
 *  - the transcript snapped to the end on every new line (26-126px in one
 *    frame) -> it now glides, critically damped;
 *  - buffered chunks landed whole (six updates of ~100 characters) -> the
 *    reveal is paced, a whole word at a time;
 *  - markdown changed shape mid-stream (a table rendered as a paragraph of
 *    pipes, then as a table) -> undecided tails are held back;
 *  - the stream-to-answer handoff remounted the row -> it keeps its key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createRef, useRef } from 'react';
import { holdUnsettledTail } from '../src/utils/markdown';
import { usePacedText, PACE_LAG_S, PACE_MAX_CPS } from '../src/hooks/usePacedText';
import { useEndFollow } from '../src/hooks/useEndFollow';
import { rehypeStreamWords } from '../src/utils/streamWords';

vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: (opts: { count: number; getItemKey: (i: number) => string }) => ({ options: { scrollMargin: 0 }, measureElement: () => {}, getTotalSize: () => 500, getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, key: opts.getItemKey(index), start: index * 100 })) }) }));
vi.mock('../src/components/MarkdownAsync', () => ({ Markdown: ({ text, streaming }: { text: string; streaming?: boolean }) => <div className="md" data-streaming={String(Boolean(streaming))}>{text}</div> }));
import { Thread } from '../src/components/Thread';
import type { ThreadItem } from '../src/types';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('markdown that has not decided its shape yet', () => {
  it('holds a table until its header and delimiter rows are whole', () => {
    expect(holdUnsettledTail('Intro.\n\n| Area | Before')).toBe('Intro.');
    expect(holdUnsettledTail('Intro.\n\n| Area | Before |\n| --- | ---')).toBe('Intro.');
    expect(holdUnsettledTail('Intro.\n\n| A | B |\n| --- | --- |')).toBe('Intro.');
  });
  it('shows table rows only once each is complete', () => {
    const table = '| A | B |\n| --- | --- |\n| one | two |\n| thr';
    expect(holdUnsettledTail(table)).toBe('| A | B |\n| --- | --- |\n| one | two |');
  });
  it('shows emphasis and inline code closed while they are being typed', () => {
    expect(holdUnsettledTail('- **Lists and')).toBe('- **Lists and**');
    expect(holdUnsettledTail('Use the `glide')).toBe('Use the `glide`');
    // Just opened, nothing inside yet: drop the marker rather than show four asterisks.
    expect(holdUnsettledTail('Now **')).toBe('Now');
    expect(holdUnsettledTail('A `**` b and **c')).toBe('A `**` b and **c**');
  });
  it('closes single * and _ emphasis, but never arithmetic, snake_case or list markers', () => {
    expect(holdUnsettledTail('This is *really')).toBe('This is *really*');
    expect(holdUnsettledTail('This is _quite')).toBe('This is _quite_');
    expect(holdUnsettledTail('So 2 * 3 is')).toBe('So 2 * 3 is');
    expect(holdUnsettledTail('Call read_file and')).toBe('Call read_file and');
    expect(holdUnsettledTail('* one item')).toBe('* one item');
    expect(holdUnsettledTail('Done *already* and')).toBe('Done *already* and');
    expect(holdUnsettledTail('Mixed *foo _bar')).toBe('Mixed *foo _bar_*');
    expect(holdUnsettledTail('Escaped \\*literal and')).toBe('Escaped \\*literal and');
  });
  it('waits for the first word of a heading or list item', () => {
    expect(holdUnsettledTail('Done.\n\n##')).toBe('Done.');
    expect(holdUnsettledTail('Steps:\n\n1.')).toBe('Steps:');
    expect(holdUnsettledTail('Steps:\n- one\n-')).toBe('Steps:\n- one');
  });
  it('leaves settled text and open code fences alone', () => {
    expect(holdUnsettledTail('Plain words here.')).toBe('Plain words here.');
    const fence = '```ts\nconst a = `x**';
    expect(holdUnsettledTail(fence)).toBe(fence);
  });
});

describe('the live dot', () => {
  const tree = (last: object) => ({ type: 'root', children: [{ type: 'element', tagName: 'p', children: [{ type: 'text', value: 'Hi' }] }, last] });
  const hasDot = (node: any): boolean => node.properties?.className?.includes?.('caret-dot') || (node.children || []).some(hasDot);
  it('sits at the end of a line of text', () => {
    const t = tree({ type: 'element', tagName: 'ul', children: [{ type: 'element', tagName: 'li', children: [{ type: 'text', value: 'one' }] }] });
    rehypeStreamWords({ block: -1, shown: 0 })(t as never);
    expect(hasDot(t.children[1])).toBe(true);
  });
  it('never lands inside a table or a code wrapper, where it added a phantom line', () => {
    const table = tree({ type: 'element', tagName: 'table', children: [{ type: 'element', tagName: 'tbody', children: [] }] });
    rehypeStreamWords({ block: -1, shown: 0 })(table as never);
    expect(hasDot(table)).toBe(false);
    const code = tree({ type: 'element', tagName: 'div', properties: { className: ['code-fence'] }, children: [] });
    rehypeStreamWords({ block: -1, shown: 0 })(code as never);
    expect(hasDot(code)).toBe(false);
  });
});

describe('paced reveal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout', 'Date'] });
  });
  const burst = 'The quick brown fox jumps over the lazy dog and keeps running far across the open field until evening comes. ';

  it('spreads a burst over time, a whole word at a time', () => {
    const { result, rerender } = renderHook(({ t, a }) => usePacedText(t, a), { initialProps: { t: 'Hi ', a: true } });
    rerender({ t: 'Hi ' + burst.repeat(2), a: true });
    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      act(() => { vi.advanceTimersByTime(16); });
      seen.push(result.current.text);
    }
    const target = 'Hi ' + burst.repeat(2);
    // Not dumped in one frame...
    expect(seen[0].length).toBeLessThan(target.length / 3);
    // ...and every cut falls between words.
    for (const s of seen) expect(s === '' || /\s$/.test(s) || s === target).toBe(true);
    act(() => { vi.advanceTimersByTime(PACE_LAG_S * 1000 * 6); });
    expect(result.current.text.trimEnd()).toBe(target.trimEnd());
  });

  it('finishes its run after the stream settles, then reports settled', () => {
    const text = 'Hi ' + burst.repeat(3);
    const { result, rerender } = renderHook(({ t, a }) => usePacedText(t, a), { initialProps: { t: 'Hi ', a: true } });
    rerender({ t: text, a: true });
    act(() => { vi.advanceTimersByTime(48); });
    rerender({ t: text, a: false });
    expect(result.current.revealing).toBe(true);
    expect(result.current.text.length).toBeLessThan(text.length);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.text).toBe(text);
    expect(result.current.revealing).toBe(false);
  });

  it('paces a short first chunk instead of showing it whole on the first frame', () => {
    const { result } = renderHook(() => usePacedText('One two three four five six seven eight nine ten eleven twelve ', true));
    act(() => { vi.advanceTimersByTime(16); });
    expect(result.current.text.length).toBeLessThan(20);
  });

  it('stops its frame loop while the stream is idle and resumes on new text', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const { result, rerender } = renderHook(({ t, a }) => usePacedText(t, a), { initialProps: { t: 'Hi ', a: true } });
    rerender({ t: 'Hi there friend', a: true });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.text).toBe('Hi there friend');
    const calls = raf.mock.calls.length;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(raf.mock.calls.length).toBe(calls);
    rerender({ t: 'Hi there friend, again ', a: true });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.text).toBe('Hi there friend, again ');
    raf.mockRestore();
  });

  it('caps a large appended burst rather than accelerating whole paragraphs into one frame', () => {
    const { result, rerender } = renderHook(({ text }) => usePacedText(text, true), { initialProps: { text: 'Hi ' } });
    rerender({ text: 'Hi ' + burst.repeat(50) });
    act(() => { vi.advanceTimersByTime(96); });
    expect(result.current.text.length).toBeLessThanOrEqual(3 + Math.ceil(PACE_MAX_CPS * 0.1));
  });

  it('paces a large first buffer when it belongs to a newly arriving live row', () => {
    const text = burst.repeat(5);
    const { result } = renderHook(() => usePacedText(text, true, true));
    expect(result.current.text).toBe('');
    act(() => { vi.advanceTimersByTime(96); });
    expect(result.current.text.length).toBeGreaterThan(0);
    expect(result.current.text.length).toBeLessThanOrEqual(Math.ceil(PACE_MAX_CPS * 0.1));
  });

  it('shows history, and an answer already long when the chat opens, at once', () => {
    expect(renderHook(() => usePacedText(burst, false)).result.current).toEqual({ text: burst, revealing: false });
    const long = burst.repeat(3);
    expect(renderHook(() => usePacedText(long, true)).result.current.text).toBe(long);
  });
});

describe('the end follow', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  });
  function setup(flags: { pinned?: boolean; landing?: boolean; touching?: boolean } = {}) {
    const el = document.createElement('div');
    let height = 1000;
    Object.defineProperty(el, 'scrollHeight', { get: () => height, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => 500, configurable: true });
    el.scrollTop = 500;
    // jsdom has no element scrollTo; clamp like a browser does.
    el.scrollTo = ((opts: ScrollToOptions) => { el.scrollTop = Math.min(opts.top ?? 0, height - 500); }) as typeof el.scrollTo;
    const ref = { current: el };
    const refs = { pinned: { current: flags.pinned ?? true }, landing: { current: flags.landing ?? false }, touching: { current: flags.touching ?? false } };
    const { result } = renderHook(() => useEndFollow(ref, refs, () => {}));
    return { el, refs, follow: result.current, grow: (by: number) => { height += by; } };
  }

  it('glides to new content instead of snapping', () => {
    const { el, follow, grow } = setup();
    grow(120);
    act(() => { follow.kick(); vi.advanceTimersByTime(17); });
    const first = el.scrollTop - 500;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(40);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(el.scrollTop).toBe(620);
  });

  it('never moves faster after a slow frame than the curve allows', () => {
    const { el, follow, grow } = setup();
    grow(90);
    act(() => { follow.kick(); vi.advanceTimersByTime(45); });
    // A naive spring step overshot to ~41px here.
    expect(el.scrollTop - 500).toBeLessThan(20);
  });

  it('lands instantly while a session is opening', () => {
    const { el, follow, grow } = setup({ landing: true });
    grow(3000);
    act(() => { follow.kick(); });
    expect(el.scrollTop).toBe(3500);
  });

  it('lets a gesture cancel a glide before wheel or fling momentum', () => {
    const wheel = setup();
    wheel.grow(300);
    act(() => { wheel.follow.kick(); vi.advanceTimersByTime(34); });
    act(() => { wheel.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 })); });
    expect(wheel.refs.pinned.current).toBe(false);
    const at = wheel.el.scrollTop;
    act(() => { wheel.follow.kick(); vi.advanceTimersByTime(800); });
    expect(wheel.el.scrollTop).toBe(at);
    const fling = setup();
    fling.grow(300);
    act(() => { fling.follow.kick(); vi.advanceTimersByTime(34); });
    act(() => { fling.refs.pinned.current = false; fling.follow.cancel(); fling.el.scrollTop = 300; vi.advanceTimersByTime(800); });
    expect(fling.el.scrollTop).toBe(300);
    // More content arriving afterwards must not pull them back down.
    expect(fling.refs.pinned.current).toBe(false);
    fling.grow(100);
    act(() => { fling.follow.kick(); vi.advanceTimersByTime(800); });
    expect(fling.el.scrollTop).toBe(300);
  });

  it('leaves the reader alone when a finger is down or they scrolled away', () => {
    const touched = setup({ touching: true });
    touched.grow(200);
    act(() => { touched.follow.kick(); vi.advanceTimersByTime(500); });
    expect(touched.el.scrollTop).toBe(500);
    const away = setup({ pinned: false });
    away.grow(200);
    act(() => { away.follow.kick(); vi.advanceTimersByTime(500); });
    expect(away.el.scrollTop).toBe(500);
  });
});

describe('the stream-to-answer handoff', () => {
  const base = { sessionId: 'synthetic', sources: {}, subagentSteps: {}, onInspectSubagent: () => {}, onOpenCitation: () => {}, scrollElementRef: createRef<HTMLDivElement>() };
  const user: ThreadItem = { kind: 'user', id: 'u', text: 'Question', ts: 1 };
  it('paces an oversized first chunk arriving after the thread is already open', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const text = 'A buffered answer should remain readable and stable. '.repeat(20);
    const { container, rerender } = render(<Thread {...base} items={[user]} />);
    rerender(<Thread {...base} items={[user, { kind: 'streaming', id: 'streaming', text }]} />);
    expect(container.querySelector('.answer .md')?.textContent?.length).toBe(0);
    act(() => { vi.advanceTimersByTime(96); });
    expect(container.querySelector('.answer .md')?.textContent?.length).toBeLessThan(60);
  });

  it('keeps the same row on screen when the settled answer replaces the stream', () => {
    const { container, rerender } = render(<Thread {...base} items={[user, { kind: 'streaming', id: 'streaming', text: 'The answer' }]} />);
    const row = container.querySelector('[data-index="1"]');
    const answer = row?.querySelector('.answer');
    expect(answer).toBeTruthy();
    rerender(<Thread {...base} items={[user, { kind: 'answer', id: 'a-1', text: 'The answer', ts: 2 }]} />);
    expect(container.querySelector('[data-index="1"] .answer')).toBe(answer);
    // A later turn's stream is a new row, not the old answer's.
    rerender(<Thread {...base} items={[user, { kind: 'answer', id: 'a-1', text: 'The answer', ts: 2 }, { kind: 'user', id: 'u2', text: 'More', ts: 3 }, { kind: 'streaming', id: 'streaming', text: 'Next' }]} />);
    expect(container.querySelector('[data-index="1"] .answer')).toBe(answer);
    expect(container.querySelectorAll('.answer')).toHaveLength(2);
  });
});
