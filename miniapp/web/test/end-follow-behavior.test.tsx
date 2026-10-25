import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEndFollow } from '../src/hooks/useEndFollow';
let callbacks: ResizeObserverCallback[] = [];
let frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
function fixture() {
  callbacks = []; frames = new Map(); frameId = 0;
  vi.stubGlobal('ResizeObserver', class { constructor(cb: ResizeObserverCallback) { callbacks.push(cb); } observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const el = document.createElement('div'); const child = document.createElement('div');el.append(child);document.body.append(el);
  let height=1000; let top=400;
  Object.defineProperties(el,{scrollHeight:{get:()=>height},clientHeight:{get:()=>600},scrollTop:{get:()=>top,set:(v:number)=>{top=v}}});
  el.scrollTo=vi.fn((opts: ScrollToOptions|number)=>{if(typeof opts==='object')top=Math.max(0,Math.min(height-600,opts.top??0))});
  const pinned={current:true},landing={current:false},touching={current:false};
  const scroller={current:el},refs={pinned,landing,touching};const onMove=vi.fn();
  const {result}=renderHook(()=>useEndFollow(scroller,refs,onMove));
  const resize=(target=child)=>act(()=>callbacks[0]([{target} as unknown as ResizeObserverEntry],{} as ResizeObserver));
  const step=(t:number)=>act(()=>{const queue=[...frames.values()];frames.clear();queue.forEach(cb=>cb(t))});
  return {el,result,pinned,landing,touching,resize,step,get top(){return top},grow:(n:number)=>{height+=n}};
}
afterEach(()=>{cleanup();document.body.innerHTML='';vi.unstubAllGlobals();vi.restoreAllMocks()});
describe('end following has one cancellable owner',()=>{
  it('cancels an in-flight glide immediately when the reader takes control',()=>{
    const f=fixture();f.grow(100);f.resize();expect(f.result.current.active()).toBe(true);
    f.pinned.current=false;f.result.current.cancel();const before=f.top;f.step(performance.now()+32);
    expect(f.result.current.active()).toBe(false);expect(f.top).toBe(before);
    f.grow(100);f.resize();expect(f.top).toBe(before);expect(frames.size).toBe(0);
  });
  it('never moves while a finger is down, including viewport resize',()=>{
    const f=fixture();f.touching.current=true;f.grow(100);f.resize();f.resize(f.el);
    expect(f.top).toBe(400);expect(f.el.scrollTo).not.toHaveBeenCalled();
  });
  it('does not move an unpinned reader when new content arrives near the end',()=>{
    const f=fixture();f.el.scrollTop=340;f.pinned.current=false;f.grow(100);f.resize();f.result.current.kick();
    expect(f.top).toBe(340);expect(f.result.current.active()).toBe(false);
  });
  it('lands immediately while hidden, then uses a monotonic glide after reveal',()=>{
    const f=fixture();f.landing.current=true;f.grow(100);f.resize();expect(f.top).toBe(500);
    f.landing.current=false;f.grow(100);f.resize();const positions=[];const now=performance.now();
    for(let i=1;i<=80;i++){f.step(now+i*16);positions.push(f.top)}
    expect(positions[0]).toBeGreaterThan(500);expect(positions[0]).toBeLessThan(600);
    expect(positions.at(-1)).toBe(600);expect(positions.every((x,i)=>!i||x>=positions[i-1])).toBe(true);
  });
});

describe('large growth never snaps before its glide',()=>{
  it('limits each automatic step while keeping reader cancellation available',()=>{
    const f=fixture();f.grow(5000);const before=f.top;f.resize();
    expect(f.top).toBe(before);
    const now=performance.now();f.step(now+16);
    expect(f.top-before).toBeGreaterThan(0);expect(f.top-before).toBeLessThanOrEqual(45);
    f.pinned.current=false;f.result.current.cancel();const stopped=f.top;f.step(now+32);expect(f.top).toBe(stopped);
  });
});

describe('layout clamping is not a gesture',()=>{
  it('does not unpin when a shrinking document moves scrollTop upward',()=>{
    const f=fixture();f.grow(300);f.resize();const now=performance.now();f.step(now+16);
    f.el.scrollTop=300;f.step(now+32);
    expect(f.pinned.current).toBe(true);expect(f.top).toBeGreaterThan(300);expect(f.result.current.active()).toBe(true);
  });
});

describe('explicit activity expansion', () => {
  function expand(f: ReturnType<typeof fixture>, bottom = 1600) {
    const target = f.el.firstElementChild as HTMLElement;
    vi.spyOn(f.el, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => ({ bottom: bottom - f.top } as DOMRect));
    target.dispatchEvent(new CustomEvent('aside:activity-expand', { bubbles: true, detail: { target } }));
    return target;
  }
  it('reveals the opened work, not later messages, then returns control to the reader', () => {
    const f = fixture(); f.pinned.current = false;
    expand(f); f.grow(1000);
    expect(f.top).toBe(400);
    const now = performance.now(); const positions: number[] = [];
    for (let i = 1; i <= 120; i++) { f.step(now + i * 16); positions.push(f.top); }
    expect(positions[0]).toBeGreaterThan(400);
    expect(positions[0]).toBeLessThan(500);
    expect(f.top).toBeCloseTo(1012, 0);
    expect(f.top).toBeLessThan(f.el.scrollHeight - f.el.clientHeight);
    expect(positions.every((value, i) => !i || value >= positions[i - 1])).toBe(true);
    expect(f.result.current.active()).toBe(false);
    expect(f.pinned.current).toBe(false);
    const before = f.top; f.grow(500); f.resize();
    expect(f.top).toBe(before);
  });
  it('lets a real wheel gesture cancel the disclosure follow immediately', () => {
    const f = fixture(); f.pinned.current = false; expand(f); f.grow(1000);
    const now = performance.now(); f.step(now + 16); f.step(now + 32);
    f.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -30 }));
    const before = f.top; f.step(now + 48); f.resize();
    expect(f.top).toBe(before); expect(f.result.current.active()).toBe(false);
  });
  it('uses committed geometry once, without animation, for reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const f = fixture(); f.pinned.current = false; expand(f); f.grow(1000);
    expect(f.top).toBe(400);
    f.step(performance.now() + 16);
    expect(f.top).toBe(1012); expect(f.result.current.active()).toBe(false);
  });
});

it('a quick close cancels an explicit reveal, including keyboard-activated closes', () => {
  const f = fixture(); f.pinned.current = false;
  const target = f.el.firstElementChild as HTMLElement;
  vi.spyOn(f.el, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
  vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => ({ bottom: 1600 - f.top } as DOMRect));
  target.dispatchEvent(new CustomEvent('aside:activity-expand', { bubbles: true, detail: { target, expanded: true } }));
  f.grow(1000); f.step(performance.now() + 16);
  target.dispatchEvent(new CustomEvent('aside:activity-expand', { bubbles: true, detail: { target, expanded: false } }));
  const before = f.top; f.step(performance.now() + 48); f.resize();
  expect(f.top).toBe(before); expect(f.result.current.active()).toBe(false);
});
