import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERLAY_MS, useAnimatedClose } from '../src/hooks/useAnimatedClose';
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers()});
describe('popup exit lifecycle',()=>{
  it('keeps its last rendered opacity and closes exactly once after reverse motion',()=>{
    vi.useFakeTimers();const close=vi.fn(),el=document.createElement('div');el.style.opacity='0.4';const root={current:el};
    const {result}=renderHook(()=>useAnimatedClose(close,root));act(()=>{result.current.close();result.current.close()});
    expect(result.current.leaving).toBe(true);expect(el.style.getPropertyValue('--motion-close-opacity')).toBe('0.4');
    act(()=>vi.advanceTimersByTime(OVERLAY_MS-1));expect(close).not.toHaveBeenCalled();act(()=>vi.advanceTimersByTime(1));expect(close).toHaveBeenCalledTimes(1);
  });
  it('cancels stale dismissal when another image is opened during exit',()=>{
    vi.useFakeTimers();const close=vi.fn();const {result}=renderHook(()=>useAnimatedClose(close));act(()=>result.current.close());
    act(()=>{vi.advanceTimersByTime(100);result.current.reset()});act(()=>vi.advanceTimersByTime(1000));expect(close).not.toHaveBeenCalled();expect(result.current.leaving).toBe(false);
  });
  it('closes immediately for reduced motion',()=>{
    vi.spyOn(window,'matchMedia').mockReturnValue({matches:true} as MediaQueryList);const close=vi.fn();const {result}=renderHook(()=>useAnimatedClose(close));act(()=>result.current.close());expect(close).toHaveBeenCalledTimes(1);
  });
});
