import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { DROP_GRACE_MS, useThread } from '../src/hooks/useThread';
import { WorkFold } from '../src/components/WorkFold';
import { api } from '../src/api';
import type { ThreadResponse, WorkBlock } from '../src/types';

const sockets = vi.hoisted(() => ({ opened: null as null | ((open: boolean) => void) }));
vi.mock('../src/api', () => ({ api: { thread: vi.fn() }, TranscriptSocket: class {
  constructor(_id: string, _events: (event: unknown) => void, private opened: (open: boolean) => void) { sockets.opened = opened; }
  connect() { this.opened(true); } close() {} setRev() {} resync() {}
} }));
const thread = () => ({ title: 'Synthetic chat', items: [], queue: [], stats: {}, sources: {}, subagentSteps: [], todos: [], rev: '1', busy: true }) as unknown as ThreadResponse;

beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.thread).mockResolvedValue(thread()); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('socket blips stay silent', () => {
  it('a drop that heals inside the grace window changes nothing on screen', async () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useThread('synthetic-blip'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(hook.result.current.connected).toBe(true);
    act(() => sockets.opened?.(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(DROP_GRACE_MS - 500); });
    expect(hook.result.current.connected).toBe(true);
    act(() => sockets.opened?.(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(DROP_GRACE_MS * 2); });
    expect(hook.result.current.connected).toBe(true);
    expect(hook.result.current.reconnectedAt).toBe(0);
  });

  it('a real outage still reports offline and then announces recovery once', async () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useThread('synthetic-outage'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    act(() => sockets.opened?.(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(DROP_GRACE_MS + 10); });
    expect(hook.result.current.connected).toBe(false);
    act(() => sockets.opened?.(true));
    expect(hook.result.current.connected).toBe(true);
    expect(hook.result.current.reconnectedAt).toBeGreaterThan(0);
  });
});

const step = (id: string) => ({ kind: 'step' as const, id, label: 'Step ' + id, tool: 'bash', icon: 'terminal', status: 'success' as const, diffstat: null, detail: null, images: [] });
const note = (id: string) => ({ kind: 'text' as const, id, text: 'Note ' + id });
const block = (items: WorkBlock['items']): WorkBlock => ({ kind: 'work', id: 'work-flicker', running: true, durationMs: 0, items });
const fold = (b: WorkBlock) => <WorkFold block={b} sessionId="lab" live subagentSteps={{}} onInspectSubagent={() => {}} sources={{}} onOpenCitation={() => {}} />;

describe('work rows animate only for live arrivals', () => {
  it('one new run arriving gets an entrance', () => {
    const view = render(fold(block([step('a1'), note('n1')])));
    view.rerender(fold(block([step('a1'), note('n1'), step('a2')])));
    expect(document.querySelectorAll('.tl-item.is-fresh')).toHaveLength(1);
  });

  it('a resync that hands over many runs at once does not replay them all', () => {
    const view = render(fold(block([step('b1')])));
    view.rerender(fold(block([step('b1'), note('m1'), step('b2'), note('m2'), step('b3'), note('m3')])));
    expect(document.querySelectorAll('.tl-item.is-fresh')).toHaveLength(0);
  });

  it('runs already drawn elsewhere stay still when they move into a fold', () => {
    const first = render(fold(block([step('c1'), note('o1')])));
    first.unmount();
    const view = render(fold(block([step('z0')])));
    view.rerender(fold(block([step('z0'), step('c1') as never, note('o1')].map((x, i) => (i === 1 ? { ...x, subagent: undefined } : x)) as WorkBlock['items'])));
    const fresh = [...document.querySelectorAll('.tl-item.is-fresh')].map((el) => el.textContent);
    expect(fresh.some((text) => text?.includes('Note o1'))).toBe(false);
  });
});

describe('the footer halo holds still while following new content', () => {
  it('a pinned follow counts as at the end, so the jump button and blur halo do not blink', async () => {
    const fs = await import('node:fs');
    const app = fs.readFileSync('src/App.tsx', 'utf8');
    expect(app).toMatch(/const atEnd = remaining <= 2 \|\| \(pinned\.current && \(landing\.current \|\| !readerOwnsScroll\.current\)\);/);
  });

  it('opened run steps get horizontal clip room and the context clip is rounded', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync('src/theme/system.css', 'utf8');
    expect(css).toMatch(/\.fold > \.motion-collapse > \.motion-collapse-inner \{\s*padding-inline: 12px;\s*margin-inline: -12px;/);
    expect(css).toMatch(/\.composer-context \{\s*border-radius: 12px;/);
  });
});
