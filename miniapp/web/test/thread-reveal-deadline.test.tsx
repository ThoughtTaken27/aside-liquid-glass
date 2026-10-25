import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mode=vi.hoisted(()=>({unready:false}));
vi.mock('@tanstack/react-virtual',()=>({defaultRangeExtractor:()=>[0],useVirtualizer:()=>({getVirtualItems:()=>[{index:0,key:'stream',start:0}],getTotalSize:()=>100,options:{scrollMargin:0},measureElement:()=>{},shouldAdjustScrollPositionOnItemSizeChange:undefined})}));
vi.mock('../src/components/MarkdownAsync',()=>({Markdown:({text}:{text:string})=><div className="md">{text}{mode.unready ? <div className="md-visual" /> : null}</div>}));
import { Thread } from '../src/components/Thread';
afterEach(()=>{mode.unready=false;cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()});
describe('opening a running chat has a real reveal deadline',()=>{
  it('reveals once even if streaming geometry never holds still for six frames',async()=>{
    vi.useFakeTimers();let height=0;
    vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(()=>++height);
    vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>window.setTimeout(()=>cb(performance.now()),16));
    vi.stubGlobal('cancelAnimationFrame',(id:number)=>window.clearTimeout(id));
    const scroller=document.createElement('div');const onReveal=vi.fn();
    const view=render(<Thread items={[{kind:'streaming',id:'stream',text:'Growing answer'}]} sessionId="synthetic" sources={{}} subagentSteps={{}} onInspectSubagent={()=>{}} onOpenCitation={()=>{}} scrollElementRef={{current:scroller}} onReveal={onReveal}/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(2400)});
    expect(view.container.querySelector('.thread')?.getAttribute('data-revealed')).toBe('settling');
    await act(async()=>{await vi.advanceTimersByTimeAsync(300)});
    expect(view.container.querySelector('.thread')?.getAttribute('data-revealed')).toBe('fade');expect(onReveal).toHaveBeenCalledTimes(1);
  });
});

 it('does not spend the live-stream deadline on an idle unresolved visual',async()=>{
    mode.unready=true;vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>window.setTimeout(()=>cb(performance.now()),16));
    vi.stubGlobal('cancelAnimationFrame',(id:number)=>window.clearTimeout(id));
    const draw=()=><Thread items={[{kind:'answer',id:'idle',text:mode.unready?'Saved answer':'Ready answer',ts:0}]} sessionId="synthetic" sources={{}} subagentSteps={{}} onInspectSubagent={()=>{}} onOpenCitation={()=>{}} scrollElementRef={{current:document.createElement('div')}}/>;
    const view=render(draw());
    await act(async()=>{await vi.advanceTimersByTimeAsync(3000)});
    expect(view.container.querySelector('.thread')?.getAttribute('data-revealed')).toBe('settling');
    mode.unready=false;view.rerender(draw());
    await act(async()=>{await vi.advanceTimersByTimeAsync(200)});
    expect(view.container.querySelector('.thread')?.getAttribute('data-revealed')).toBe('fade');
  });
