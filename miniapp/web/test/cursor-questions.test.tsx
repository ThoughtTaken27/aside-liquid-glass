import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QuestionCard } from '../src/components/QuestionCard';
import type { QuestionItem } from '../src/types';
let serial=0,client:string|undefined;
beforeEach(()=>{client=document.documentElement.dataset.client;document.documentElement.dataset.client='standalone';});
afterEach(()=>{cleanup();if(client===undefined)delete document.documentElement.dataset.client;else document.documentElement.dataset.client=client;});
const one=(over:Partial<QuestionItem>={}):QuestionItem=>({kind:'question',id:`cursor-${++serial}`,variant:'ask',source:'marker',status:'pending',answerable:true,questions:[{header:'Route',question:'Which route should I use?',options:[{label:'First route',description:'Read the public guide.'},{label:'Second route',description:'Use the local guide.'}]}],...over});
const many=()=>one({questions:[
 {header:'Route',question:'Which route should I use?',options:[{label:'First route',description:''},{label:'Second route',description:''}]},
 {header:'Checks',question:'Which checks should I run?',multiple:true,allowOther:false,options:[{label:'Keyboard',description:''},{label:'Phone layout',description:''}]},
 {header:'Notes',question:'What should I preserve?',options:[],otherLabel:'Your notes'},
]});
const custom=()=>screen.getByRole('textbox');
describe('Cursor questions on the standalone phone',()=>{
 it('selects locally, then submits once explicitly',async()=>{
  const answer=vi.fn().mockResolvedValue(undefined);render(<QuestionCard item={one()} onAnswer={answer}/>);
  fireEvent.click(screen.getByRole('button',{name:'First route'}));expect(answer).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'First route'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:/Submit/}));await waitFor(()=>expect(answer).toHaveBeenCalledWith('Route','First route'));
  expect(screen.getByRole('button',{name:/Questions.*1 answered/})).toBeTruthy();
 });
 it('auto-advances a single choice but retains multi choices until Next',async()=>{
  const answer=vi.fn().mockResolvedValue(undefined);render(<QuestionCard item={many()} onAnswer={answer}/>);
  fireEvent.click(screen.getByRole('button',{name:'First route'}));expect(screen.getByText('2 of 3')).toBeTruthy();expect(answer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Keyboard'}));fireEvent.click(screen.getByRole('button',{name:'Phone layout'}));
  expect(screen.getByText('2 of 3')).toBeTruthy();expect(screen.getByRole('button',{name:'Keyboard'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:/Next/}));fireEvent.change(custom(),{target:{value:'Keep my exact words.'}});
  fireEvent.click(screen.getByRole('button',{name:/Submit/}));await waitFor(()=>expect(answer).toHaveBeenCalledWith('','Route: First route\nChecks: Keyboard; Phone layout\nNotes: Keep my exact words.'));
 });
 it('Back restores each selection and custom answer',()=>{
  render(<QuestionCard item={many()} onAnswer={vi.fn()}/>);fireEvent.change(custom(),{target:{value:'Custom first answer'}});fireEvent.click(screen.getByRole('button',{name:/Next/}));
  fireEvent.click(screen.getByRole('button',{name:'Keyboard'}));fireEvent.click(screen.getByRole('button',{name:'Back'}));expect((custom() as HTMLInputElement).value).toBe('Custom first answer');
  fireEvent.click(screen.getByRole('button',{name:/Next/}));expect(screen.getByRole('button',{name:'Keyboard'}).getAttribute('aria-pressed')).toBe('true');
 });
 it('typing a custom single answer clears the selected option',async()=>{
  const answer=vi.fn().mockResolvedValue(undefined);render(<QuestionCard item={one()} onAnswer={answer}/>);
  fireEvent.click(screen.getByRole('button',{name:'First route'}));fireEvent.change(custom(),{target:{value:'Neither option'}});
  expect(screen.getByRole('button',{name:'First route'}).getAttribute('aria-pressed')).toBe('false');fireEvent.click(screen.getByRole('button',{name:/Submit/}));
  await waitFor(()=>expect(answer).toHaveBeenCalledWith('Route','Neither option'));
 });
 it('picking a single option clears the custom text',()=>{
  render(<QuestionCard item={one()} onAnswer={vi.fn()}/>);fireEvent.change(custom(),{target:{value:'Custom'}});fireEvent.click(screen.getByRole('button',{name:'Second route'}));expect((custom() as HTMLInputElement).value).toBe('');
 });
 it('coalesces duplicate Submit clicks into one request',async()=>{
  let finish!:()=>void;const answer=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));render(<QuestionCard item={one()} onAnswer={answer}/>);
  fireEvent.change(custom(),{target:{value:'Exact answer'}});const button=screen.getByRole('button',{name:/Submit/});fireEvent.click(button);fireEvent.click(button);
  await waitFor(()=>expect(answer).toHaveBeenCalledTimes(1));finish();await screen.findByRole('button',{name:/Questions.*answered/});
 });
 it('preserves answers and enables a meaningful retry after failure',async()=>{
  const answer=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);render(<QuestionCard item={one()} onAnswer={answer}/>);
  fireEvent.change(custom(),{target:{value:'Keep this exact answer'}});fireEvent.click(screen.getByRole('button',{name:/Submit/}));expect(await screen.findByRole('alert')).toBeTruthy();
  expect((custom() as HTMLInputElement).value).toBe('Keep this exact answer');fireEvent.click(screen.getByRole('button',{name:/Submit/}));await waitFor(()=>expect(answer).toHaveBeenCalledTimes(2));
 });
 it('keeps draft state across virtualized remounts within the same session',()=>{
  const item=many();const view=render(<QuestionCard item={item} cacheKey="session-a:question" onAnswer={vi.fn()}/>);fireEvent.change(custom(),{target:{value:'Do not lose this'}});fireEvent.click(screen.getByRole('button',{name:/Next/}));view.unmount();
  render(<QuestionCard item={item} cacheKey="session-a:question" onAnswer={vi.fn()}/>);expect(screen.getByText('2 of 3')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Back'}));expect((custom() as HTMLInputElement).value).toBe('Do not lose this');
 });
 it('does not share drafts between sessions with the same question id',()=>{
  const item=one();const a=render(<QuestionCard item={item} cacheKey="scope-one" onAnswer={vi.fn()}/>);fireEvent.change(custom(),{target:{value:'Private draft'}});a.unmount();
  render(<QuestionCard item={item} cacheKey="scope-two" onAnswer={vi.fn()}/>);expect((custom() as HTMLInputElement).value).toBe('');
 });
 it('does not reuse an answer when the question payload changes',()=>{
  const item=one();const view=render(<QuestionCard item={item} onAnswer={vi.fn()}/>);fireEvent.change(custom(),{target:{value:'Old answer'}});
  view.rerender(<QuestionCard item={{...item,questions:[{...item.questions[0],question:'A different question'}]}} onAnswer={vi.fn()}/>);expect((custom() as HTMLInputElement).value).toBe('');
 });
 it('never routes native questions through the ordinary answer endpoint',async()=>{
  const answer=vi.fn(),recover=vi.fn().mockResolvedValue(undefined);render(<QuestionCard item={one({source:'tool',answerable:false})} onAnswer={answer} onRecover={recover} busy/>);
  fireEvent.click(screen.getByRole('button',{name:'First route'}));expect(recover).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:/Continue in a new session/}));
  await waitFor(()=>expect(recover).toHaveBeenCalledWith('First route'));expect(answer).not.toHaveBeenCalled();
 });
 it('allows an explicit native continuation without inventing an answer',async()=>{
  const recover=vi.fn().mockResolvedValue(undefined);render(<QuestionCard item={one({source:'tool',answerable:false})} onRecover={recover} busy/>);
  expect(screen.queryByRole('button',{name:'Skip all'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:/Continue in a new session/}));await waitFor(()=>expect(recover).toHaveBeenCalledWith(''));
 });
 it('keeps read-only questions inspectable without sending or recovering',()=>{
  const item=many();render(<QuestionCard item={{...item,source:'tool',answerable:false}}/>);
  expect((screen.getByRole('button',{name:'First route'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText(/Respond from Aside/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/Next/}));expect(screen.getByText('2 of 3')).toBeTruthy();
 });
 it('does not interpret skipped questions as approval or invented answers',async()=>{
  const answer=vi.fn().mockResolvedValue(undefined);render(<QuestionCard item={many()} onAnswer={answer}/>);fireEvent.click(screen.getByRole('button',{name:'Skip all'}));
  await waitFor(()=>expect(answer).toHaveBeenCalledWith('','Skip these questions. No answers provided.'));expect(screen.getByRole('button',{name:/Questions.*Skipped/})).toBeTruthy();
 });
 it('numbers are shortcuts only inside the panel, never inside a text input',()=>{
  const answer=vi.fn();render(<QuestionCard item={many()} onAnswer={answer}/>);const input=custom();fireEvent.keyDown(input,{key:'1'});expect(screen.getByText('1 of 3')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('region',{name:'Questions'}),{key:'1'});expect(screen.getByText('2 of 3')).toBeTruthy();expect(answer).not.toHaveBeenCalled();
 });
 it('does not submit for IME Enter, repeated Enter, or final ArrowRight',()=>{
  const answer=vi.fn();render(<QuestionCard item={one()} onAnswer={answer}/>);fireEvent.change(custom(),{target:{value:'Hello'}});
  fireEvent.keyDown(custom(),{key:'Enter',isComposing:true});fireEvent.keyDown(custom(),{key:'Enter',repeat:true});fireEvent.keyDown(screen.getByRole('region',{name:'Questions'}),{key:'ArrowRight'});expect(answer).not.toHaveBeenCalled();
 });
 it('Enter explicitly submits a completed custom answer',async()=>{
  const answer=vi.fn().mockResolvedValue(undefined);render(<QuestionCard item={one()} onAnswer={answer}/>);fireEvent.change(custom(),{target:{value:'Typed answer'}});fireEvent.keyDown(custom(),{key:'Enter'});await waitFor(()=>expect(answer).toHaveBeenCalledWith('Route','Typed answer'));
 });
 it('shows submitted values in a read-only expandable receipt',()=>{
  render(<QuestionCard item={one({status:'answered',answer:'The original answer'})}/>);expect(screen.queryByRole('textbox')).toBeNull();expect(screen.getByRole('button',{name:/Show.*answers/}).textContent).toContain('Answered');expect(screen.getByRole('button',{name:/Show.*answers/}).textContent).not.toContain('undefined');fireEvent.click(screen.getByRole('button',{name:/Show.*answers/}));expect(screen.getByText('The original answer')).toBeTruthy();expect(screen.getByText('Which route should I use?')).toBeTruthy();
 });
 it('leaves confirmation cards on the original direct-approval path',()=>{
  const answer=vi.fn();render(<QuestionCard item={one({variant:'confirm'})} onAnswer={answer}/>);expect(document.querySelector('.cursor-questions')).toBeNull();fireEvent.click(screen.getByRole('button',{name:/First route/}));expect(answer).toHaveBeenCalledWith('Route','First route');
 });
 it('does not persist newly typed private text to browser storage',()=>{
  const local=vi.spyOn(Storage.prototype,'setItem');render(<QuestionCard item={one()} onAnswer={vi.fn()}/>);local.mockClear();fireEvent.change(custom(),{target:{value:'Local only until submit'}});expect(local).not.toHaveBeenCalled();local.mockRestore();
 });
 it('keeps repeated question headers unambiguous in a complete reply',async()=>{
  const answer=vi.fn().mockResolvedValue(undefined);const item=one({questions:[{header:'Choice',question:'First question?',options:[{label:'Yes',description:''}]},{header:'Choice',question:'Second question?',options:[{label:'No',description:''}]}]});
  render(<QuestionCard item={item} onAnswer={answer}/>);fireEvent.click(screen.getByRole('button',{name:'Yes'}));fireEvent.click(screen.getByRole('button',{name:'No'}));fireEvent.click(screen.getByRole('button',{name:/Submit/}));
  await waitFor(()=>expect(answer).toHaveBeenCalledWith('','Choice (question 1): Yes\nChoice (question 2): No'));
 });
 it('does not create another in-flight request after a virtualized remount',async()=>{
  let finish!:()=>void;const answer=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})),item=one();const a=render(<QuestionCard item={item} cacheKey="flight-scope" onAnswer={answer}/>);
  fireEvent.click(screen.getByRole('button',{name:'First route'}));fireEvent.click(screen.getByRole('button',{name:/Submit/}));await waitFor(()=>expect(answer).toHaveBeenCalledTimes(1));a.unmount();
  render(<QuestionCard item={item} cacheKey="flight-scope" onAnswer={answer}/>);expect((screen.getByRole('button',{name:/Sending/}) as HTMLButtonElement).disabled).toBe(true);finish();await screen.findByRole('button',{name:/Questions.*answered/});expect(answer).toHaveBeenCalledTimes(1);
 });
 it('does not animate a pointer-driven question change when reduced motion is requested',()=>{
  const match=window.matchMedia,animate=Element.prototype.animate,spy=vi.fn();
  window.matchMedia=vi.fn().mockReturnValue({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()});Element.prototype.animate=spy;
  try{render(<QuestionCard item={many()} onAnswer={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'First route'}),{detail:1});expect(screen.getByText('2 of 3')).toBeTruthy();expect(spy).not.toHaveBeenCalled();}
  finally{window.matchMedia=match;Element.prototype.animate=animate;}
 });
 it('preserves artifact summary details in answered history',()=>{
  render(<QuestionCard item={one({status:'answered',answer:'First route',artifact:{type:'action',summary:[{label:'Preview',value:'Example action'}]}})}/>);fireEvent.click(screen.getByRole('button',{name:/Show.*answers/}));expect(screen.getByText('Example action')).toBeTruthy();
 });
});

describe('Cursor questions tap feedback (reference parity)', () => {
 it('shows a tapped single choice as chosen for a beat before advancing', async () => {
  const item = one({questions:[{header:'Route',question:'Which route should I use?',options:[{label:'First route',description:''},{label:'Second route',description:''}]},{header:'Checks',question:'Which checks?',options:[{label:'Keyboard',description:''}]}]});
  render(<QuestionCard item={item} onAnswer={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'First route'}),{detail:1});
  expect(screen.getByText('1 of 2')).toBeTruthy();
  expect(screen.getByRole('button',{name:'First route'}).getAttribute('aria-pressed')).toBe('true');
  await waitFor(()=>expect(screen.getByText('2 of 2')).toBeTruthy());
 });
});
