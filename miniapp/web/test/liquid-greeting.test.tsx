import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiquidGreeting } from '../src/components/LiquidGreeting';

const greeting = () => document.querySelector('.liquid-greeting') as HTMLElement;
const originalContext = HTMLCanvasElement.prototype.getContext;
const stops = vi.fn();
let reduced = false, compileWorks = true, linkWorks = true;
let gpu: Record<string, unknown>;
let rafCallbacks: FrameRequestCallback[] = [];
beforeEach(() => {
  reduced=false; compileWorks=true; linkWorks=true; rafCallbacks=[];
  const context = new Proxy<Record<string, unknown>>({}, { get: (target,key) => target[key as string] ?? (() => ({})) });
  Object.assign(context, { VERSION:1, getParameter:()=> 'WebGL 1', getShaderParameter:()=>compileWorks, getProgramParameter:()=>linkWorks, deleteProgram:stops, getUniformLocation:(_p:unknown,name:string)=>name, uniform1f:vi.fn(), uniform2f:vi.fn() });
  gpu=context;
  const raster = new Proxy<Record<string,unknown>>({measureText:(s:string)=>({width:s.length*20})},{get:(t,k)=>t[k as string]??(()=>{}),set:(t,k,v)=>{t[k as string]=v;return true;}});
  Object.defineProperty(HTMLCanvasElement.prototype,'getContext',{configurable:true,value:(type:string)=>type==='2d'?raster:context});
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,width:250,height:124,top:0,left:0,right:250,bottom:124,toJSON:()=>({})});
  vi.stubGlobal('IntersectionObserver',class {observe(){} disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',vi.fn((callback:FrameRequestCallback)=>{rafCallbacks.push(callback);return rafCallbacks.length;})); vi.stubGlobal('cancelAnimationFrame',vi.fn());
  vi.spyOn(window,'matchMedia').mockImplementation(q=>({matches:reduced,media:q,addEventListener:vi.fn(),removeEventListener:vi.fn()} as unknown as MediaQueryList));
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();stops.mockClear();Object.defineProperty(HTMLCanvasElement.prototype,'getContext',{configurable:true,value:originalContext});});

describe('liquid greeting resilience',()=>{
  it('retains an accessible label and normal text without WebGL',()=>{
    Object.defineProperty(HTMLCanvasElement.prototype,'getContext',{configurable:true,value:()=>null});
    render(<LiquidGreeting text={'Hey,\nAlex'}/>);
    expect(greeting().hasAttribute('data-ready')).toBe(false);
    expect(screen.getByText('Alex')).toBeTruthy();
  });
  it('does not crash the app if context creation throws',()=>{
    Object.defineProperty(HTMLCanvasElement.prototype,'getContext',{configurable:true,value:()=>{throw new Error('unavailable');}});
    expect(()=>render(<LiquidGreeting text="Good morning"/>)).not.toThrow();
  });
  it('falls back without throwing when shader compilation fails',()=>{
    compileWorks=false; expect(()=>render(<LiquidGreeting text="Hey there"/>)).not.toThrow();
    expect(greeting().hasAttribute('data-ready')).toBe(false);
  });
  it('releases partial GPU resources when program linking fails',()=>{
    linkWorks=false;render(<LiquidGreeting text="Hey there"/>);
    expect(stops).toHaveBeenCalledTimes(1);expect(greeting().hasAttribute('data-ready')).toBe(false);
  });
  it('shows fallback on context loss and reinitializes after restoration',()=>{
    const {container}=render(<LiquidGreeting text="Hey there"/>); const wrap=greeting(),canvas=container.querySelector('canvas')!;
    expect(wrap.dataset.ready).toBe('true');
    fireEvent(canvas,new Event('webglcontextlost',{cancelable:true}));expect(wrap.hasAttribute('data-ready')).toBe(false);
    fireEvent(canvas,new Event('webglcontextrestored'));expect(wrap.dataset.ready).toBe('true');
  });
  it('does not schedule animation under reduced motion',()=>{
    reduced=true; render(<LiquidGreeting text="Hey there"/>);expect(greeting().dataset.ready).toBe('true');expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
  it('keeps plain and multiword greetings intact',()=>{
    const {rerender}=render(<LiquidGreeting text="Good afternoon"/>);expect(screen.getByText('Good afternoon',{selector:'.liquid-greeting-a11y'})).toBeTruthy();
    rerender(<LiquidGreeting text={'Still awake,\nAlex Smith?'} />);expect(screen.getByText('Still awake, Alex Smith?',{selector:'.liquid-greeting-a11y'})).toBeTruthy();
  });
  it('remains a text heading rather than an image',()=>{
    render(<h1><LiquidGreeting text={'Hey,\nAlex'}/></h1>);
    expect(screen.getByRole('heading',{name:'Hey, Alex'})).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('uses the reference 8% per-frame seed response on click',()=>{
    render(<LiquidGreeting text="Hey there"/>);
    fireEvent.click(greeting());
    act(()=>rafCallbacks.shift()!(performance.now()+16));
    const calls=vi.mocked(gpu.uniform1f as ReturnType<typeof vi.fn>).mock.calls.filter(c=>c[0]==='u_seed');
    expect(calls.at(-1)?.[1]).toBeCloseTo(3.7*.08,8);
  });
  it('smooths normalized pointer coordinates at the reference response',()=>{
    render(<LiquidGreeting text="Hey there"/>);
    fireEvent(greeting(),new MouseEvent('pointermove',{clientX:250,clientY:0}));
    act(()=>rafCallbacks.shift()!(performance.now()+16));
    const calls=vi.mocked(gpu.uniform2f as ReturnType<typeof vi.fn>).mock.calls.filter(c=>c[0]==='u_mouse');
    expect(calls.at(-1)?.slice(1)).toEqual([.54,.54]);
  });
  it('supports keyboard reshaping without animation under reduced motion',()=>{
    reduced=true;render(<LiquidGreeting text="Hey there"/>);
    fireEvent.keyDown(greeting(),{key:'Enter'});
    const calls=vi.mocked(gpu.uniform1f as ReturnType<typeof vi.fn>).mock.calls.filter(c=>c[0]==='u_seed');
    expect(calls.at(-1)?.[1]).toBe(3.7);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
  it('cleans up GPU and animation resources on unmount',()=>{
    const {unmount}=render(<LiquidGreeting text="Hey there"/>);unmount();expect(stops).toHaveBeenCalledTimes(1);expect(cancelAnimationFrame).toHaveBeenCalled();
  });
});
