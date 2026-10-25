import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast, ToastHost } from '../src/components/Toasts';
afterEach(()=>{cleanup();vi.useRealTimers()});
describe('duplicate transient status does not strobe or stack',()=>{
  it('keeps one existing pill for repeated actionless connection notices',()=>{
    vi.useFakeTimers();render(<ToastHost/>);act(()=>{toast('Synthetic connection restored');toast('Synthetic connection restored')});
    expect(screen.getAllByRole('button',{name:'Dismiss: Synthetic connection restored'})).toHaveLength(1);
    act(()=>vi.advanceTimersByTime(4000));
  });
});
