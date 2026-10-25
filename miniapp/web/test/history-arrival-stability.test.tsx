import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { Thread } from '../src/components/Thread';
import type { ThreadItem } from '../src/types';
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: (opts: {count:number;getItemKey:(i:number)=>string}) => ({ options:{scrollMargin:0},measureElement:()=>{},getTotalSize:()=>500,getVirtualItems:()=>Array.from({length:opts.count},(_,index)=>({index,key:opts.getItemKey(index),start:index*100})) }) }));
vi.mock('../src/components/MarkdownAsync',()=>({Markdown:({text,live}:{text:string;live?:boolean})=><div className="md" data-live={String(Boolean(live))}>{text}</div>}));
afterEach(cleanup);
const props={sessionId:'synthetic',sources:{},subagentSteps:{},onInspectSubagent:()=>{},onOpenCitation:()=>{},scrollElementRef:createRef<HTMLDivElement>()};
describe('first history batch never replays message or visual generation',()=>{
 it('treats a single restored answer as history, not a new arrival',()=>{
  const view=render(<Thread {...props} items={[]}/>);
  view.rerender(<Thread {...props} items={[{kind:'answer',id:'old',text:'Restored answer',ts:1}]}/>);
  expect(view.container.querySelector('[data-thread-item]')?.getAttribute('data-fresh')).toBeNull();
  expect(view.container.querySelector('.md')?.getAttribute('data-live')).toBe('false');
 });
 it('keeps real streaming arrivals live and settles their final answer without another entrance',()=>{
  const view=render(<Thread {...props} items={[]}/>);
  const stream:ThreadItem={kind:'streaming',id:'streaming',text:'Live words'};
  view.rerender(<Thread {...props} items={[stream]}/>);
  expect(view.container.querySelector('.md')?.getAttribute('data-live')).toBe('true');
  view.rerender(<Thread {...props} items={[{kind:'answer',id:'final',text:'Live words',ts:2}]}/>);
  expect(view.container.querySelector('[data-thread-item]')?.getAttribute('data-fresh')).toBeNull();
  expect(view.container.querySelector('.md')?.getAttribute('data-live')).toBe('true');
 });
});
