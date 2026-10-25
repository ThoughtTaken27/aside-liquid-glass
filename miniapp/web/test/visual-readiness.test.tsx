import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { VisualBlock } from '../src/components/VisualBlock';
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers()});
describe('cached visual height is not fresh layout readiness',()=>{
  it('corrects the size while undrawn, then allows history to reveal on both first load and cached reopen',async()=>{
    vi.useFakeTimers();vi.spyOn(api,'visual').mockResolvedValue({url:'https://example.test/synthetic-visual'});
    const html='<h1>Unique synthetic readiness test</h1>';
    const first=render(<VisualBlock html={html}/>);await act(async()=>{});
    let frame=first.container.querySelector('iframe')!;expect(frame).not.toBeNull();
    fireEvent.load(frame);
    act(()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{type:'aside-visual:h',h:900}})));
    await act(async()=>{await vi.advanceTimersByTimeAsync(1290)});
    expect(first.container.querySelector('[data-ready]')).toBeNull();
    await act(async()=>{await vi.advanceTimersByTimeAsync(20)});
    expect(frame.style.height).toBe('900px');expect(frame.hasAttribute('data-drawn')).toBe(false);
    await act(async()=>{await vi.advanceTimersByTimeAsync(50)});
    expect(first.container.querySelector('.md-visual')?.getAttribute('data-ready')).toBe('true');first.unmount();
    const second=render(<VisualBlock html={html}/>);await act(async()=>{});frame=second.container.querySelector('iframe')!;
    expect(frame.style.height).toBe('900px');expect(second.container.querySelector('[data-ready]')).toBeNull();fireEvent.load(frame);
    act(()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{type:'aside-visual:h',h:1200}})));
    await act(async()=>{await vi.advanceTimersByTimeAsync(1290)});expect(frame.style.height).toBe('900px');
    await act(async()=>{await vi.advanceTimersByTimeAsync(20)});expect(frame.style.height).toBe('1200px');expect(frame.hasAttribute('data-drawn')).toBe(false);
    await act(async()=>{await vi.advanceTimersByTimeAsync(50)});expect(second.container.querySelector('.md-visual')?.getAttribute('data-ready')).toBe('true');
  });
});

it('bounds a nonresponding visual service with a stable readable fallback',async()=>{
  vi.useFakeTimers();vi.spyOn(api,'visual').mockImplementation(()=>new Promise(()=>{}));
  const view=render(<VisualBlock html="<p>Timeout synthetic visual</p>"/>);await act(async()=>{});
  expect(view.container.querySelector('.md-visual')).not.toBeNull();
  await act(async()=>{await vi.advanceTimersByTimeAsync(8100)});
  expect(view.container.querySelector('.md-visual')).toBeNull();expect(view.container.textContent).toContain('Timeout synthetic visual');
});
