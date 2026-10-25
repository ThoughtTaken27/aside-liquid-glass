import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Collapse, COLLAPSE_MS, Disclosure } from '../src/components/Collapse';
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks()});
describe('reversible disclosure presence',()=>{
  it('retains its content through closing but makes it inert immediately',()=>{
    vi.useFakeTimers();const view=render(<Collapse open><button>Inside</button></Collapse>);
    view.rerender(<Collapse open={false}><button>Inside</button></Collapse>);
    expect(screen.getByText('Inside').closest('.motion-collapse')?.hasAttribute('inert')).toBe(true);
    act(()=>vi.advanceTimersByTime(COLLAPSE_MS-1));expect(screen.getByText('Inside')).toBeTruthy();
    act(()=>vi.advanceTimersByTime(35));expect(screen.queryByText('Inside')).toBeNull();
  });
  it('reverses before close finishes without resetting the child or deleting it later',()=>{
    vi.useFakeTimers();const draw=(open:boolean)=><Collapse open={open}><input aria-label="Draft" defaultValue="preserved" /></Collapse>;
    const view=render(draw(true)),input=screen.getByRole('textbox');view.rerender(draw(false));act(()=>vi.advanceTimersByTime(100));view.rerender(draw(true));
    act(()=>vi.advanceTimersByTime(1000));expect(screen.getByRole('textbox')).toBe(input);expect(input.closest('[inert]')).toBeNull();
  });
  it('exposes a keyboard-accessible summary and linked fold instead of native instant details',()=>{
    render(<Disclosure><summary>Show evidence</summary><p>Saved facts</p></Disclosure>);const button=screen.getByRole('button',{name:'Show evidence'});
    expect(button.getAttribute('aria-expanded')).toBe('false');fireEvent.click(button);expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(button.getAttribute('aria-controls')!)?.contains(screen.getByText('Saved facts'))).toBe(true);
  });
  it('removes closed content immediately for reduced motion',()=>{
    vi.spyOn(window,'matchMedia').mockReturnValue({matches:true} as MediaQueryList);const view=render(<Collapse open><p>Body</p></Collapse>);
    view.rerender(<Collapse open={false}><p>Body</p></Collapse>);expect(screen.queryByText('Body')).toBeNull();
  });
});
