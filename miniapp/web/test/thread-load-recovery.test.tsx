import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useThread } from '../src/hooks/useThread';
import { api } from '../src/api';
import type { ThreadResponse } from '../src/types';
const sockets = vi.hoisted(() => ({ events: null as null | ((event: unknown) => void) }));
vi.mock('../src/api', () => ({ api: { thread: vi.fn() }, TranscriptSocket: class {
 constructor(_id: string, events: (event: unknown) => void, private opened: (open: boolean) => void) { sockets.events = events; }
 connect() { this.opened(true); } close() {} setRev() {} resync() {}
} }));
const thread = () => ({ title: 'Synthetic chat', items: [{ kind: 'answer', id: 'a', text: 'Loaded answer', ts: 1 }], queue: [], stats: {}, sources: {}, subagentSteps: [], todos: [], rev: '1', busy: false }) as unknown as ThreadResponse;
beforeEach(() => { vi.clearAllMocks(); sockets.events = null; });
afterEach(cleanup);
describe('chat load recovery', () => {
 it('an older rejected load cannot replace a newer successful load with an error', async () => {
  let reject!: (e: Error) => void;
  vi.mocked(api.thread).mockImplementationOnce(() => new Promise((_r,j) => { reject = j; })).mockResolvedValue(thread());
  const hook = renderHook(() => useThread('synthetic'));
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.error).toBeNull();
  await act(async () => { reject(new Error('429: old request')); });
  expect(hook.result.current.error).toBeNull(); expect(hook.result.current.items).toHaveLength(1);
 });
 it('a successful socket transcript clears the initial REST error', async () => {
  vi.mocked(api.thread).mockRejectedValue(new Error('429: transient request'));
  const hook = renderHook(() => useThread('synthetic')); await act(async () => {});
  expect(hook.result.current.error).not.toBeNull();
  act(() => sockets.events?.({ type: 'thread_delta', fromIndex: 0, length: 1, items: thread().items }));
  expect(hook.result.current.error).toBeNull(); expect(hook.result.current.loading).toBe(false);
  expect(hook.result.current.items).toHaveLength(1);
 });
 it('a delayed REST snapshot cannot replace newer socket sources or queue state', async () => {
  let release!: (r: ThreadResponse) => void;
  vi.mocked(api.thread).mockImplementationOnce(() => new Promise(r => { release = r; }));
  const hook = renderHook(() => useThread('synthetic'));
  act(() => {
    sockets.events?.({ type: 'thread_meta', stats: { totalTokens: 99, turnTokens: 12, turnStartedAt: 1 }, sources: { latest: { url: 'https://example.test/new' } } });
    sockets.events?.({ type: 'queue', items: [] });
  });
  await act(async () => { release({ ...thread(), queue: [{ id: 'removed', text: 'Already removed', attachments: [], at: 1 }], sources: { old: { url: 'https://example.test/old' } } } as unknown as ThreadResponse); });
  expect(hook.result.current.sources).toEqual({ latest: { url: 'https://example.test/new' } });
  expect(hook.result.current.stats.totalTokens).toBe(99);
  expect(hook.result.current.queue).toHaveLength(0);
 });
 it('removes a stale failure when content resumes without another turn_started',async()=>{
  vi.mocked(api.thread).mockResolvedValue(thread());const hook=renderHook(()=>useThread('synthetic'));await act(async()=>{});
  await act(async()=>{sockets.events?.({type:'turn_finished',alert:{title:'Temporary failure',description:'Try again',detail:'',tone:'destructive'}});});expect(hook.result.current.alerts).toHaveLength(1);
  act(()=>sockets.events?.({type:'stream_delta',text:'Continuing the work.'}));expect(hook.result.current.alerts).toHaveLength(0);
 });
 it('keeps a terminal error on catch-up, then removes it for genuinely later transcript content',async()=>{
  vi.mocked(api.thread).mockResolvedValue(thread());const hook=renderHook(()=>useThread('synthetic'));await act(async()=>{});
  await act(async()=>{sockets.events?.({type:'turn_finished',alert:{title:'Temporary failure',description:'Try again',detail:'',tone:'destructive'}});});
  act(()=>sockets.events?.({type:'thread_delta',fromIndex:0,length:2,items:[...thread().items,{kind:'error',id:'failure',text:'Temporary failure',ts:2,alert:{title:'Temporary failure',description:'Try again',detail:'',tone:'destructive'}}]}));expect(hook.result.current.alerts).toHaveLength(1);
  act(()=>sockets.events?.({type:'thread_delta',fromIndex:0,length:2,items:[...thread().items,{kind:'answer',id:'later-answer',text:'Recovered result.',ts:3}]}));expect(hook.result.current.alerts).toHaveLength(0);
 });
 it('clears an earlier alert when a later successful finish arrives',async()=>{
  vi.mocked(api.thread).mockResolvedValue(thread());const hook=renderHook(()=>useThread('synthetic'));await act(async()=>{});
  await act(async()=>{sockets.events?.({type:'turn_finished',alert:{title:'Temporary failure',description:'Try again',detail:'',tone:'destructive'}});});expect(hook.result.current.alerts).toHaveLength(1);
  await act(async()=>{sockets.events?.({type:'turn_finished'});});expect(hook.result.current.alerts).toHaveLength(0);
 });
});
