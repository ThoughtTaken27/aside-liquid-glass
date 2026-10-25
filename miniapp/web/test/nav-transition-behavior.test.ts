import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();delete document.documentElement.dataset.nav});
describe('interrupted navigation commits each destination once',()=>{
  it('handles skipped ready and does not replay a delayed old update',async()=>{
    vi.resetModules();let callback:()=>void=()=>{};let done:()=>void=()=>{};let rejectReady:(err:Error)=>void=()=>{};
    const ready=new Promise<void>((_,reject)=>{rejectReady=reject});
    const finished=new Promise<void>(resolve=>{done=resolve});
    const skipTransition=vi.fn(()=>rejectReady(new Error('skipped')));
    Object.defineProperty(document,'startViewTransition',{configurable:true,value:vi.fn((cb:()=>void)=>{callback=cb;return {ready,finished,skipTransition}})});
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
    const {navigate}=await import('../src/utils/navTransition');const order:string[]=[];
    navigate('push',()=>order.push('chat'));navigate('pop',()=>order.push('home'));
    callback();done();await Promise.resolve();await Promise.resolve();
    expect(order).toEqual(['chat','home']);expect(skipTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.nav).toBeUndefined();
    delete (document as Document&{startViewTransition?:unknown}).startViewTransition;
  });
  it('commits directly with reduced motion and never takes a snapshot',async()=>{
    vi.resetModules();const start=vi.fn();Object.defineProperty(document,'startViewTransition',{configurable:true,value:start});
    vi.spyOn(window,'matchMedia').mockReturnValue({matches:true} as MediaQueryList);
    const {navigate}=await import('../src/utils/navTransition');const update=vi.fn();navigate('pop',update);
    expect(update).toHaveBeenCalledTimes(1);expect(start).not.toHaveBeenCalled();
    delete (document as Document&{startViewTransition?:unknown}).startViewTransition;
  });
});
