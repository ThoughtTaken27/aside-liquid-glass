import {describe,it,expect,vi,afterEach} from 'vitest';
import {keepQuestionTargetVisible} from '../src/components/questionVisibility';
afterEach(()=>{document.body.innerHTML='';});
function fixture(){document.body.innerHTML='<main class="app-thread"><header class="thread-header"></header><div class="thread-scroll"><section><label></label><p></p></section></div><footer class="thread-footer"></footer></main>';
 const root=document.querySelector('section')!,target=document.querySelector('label')!,scroll=document.querySelector<HTMLElement>('.thread-scroll')!;
 const box=(element:Element,top:number,bottom:number)=>vi.spyOn(element,'getBoundingClientRect').mockReturnValue({top,bottom,left:0,right:320,width:320,height:bottom-top,x:0,y:top,toJSON:()=>({})});
 box(scroll,60,459);box(document.querySelector('header')!,0,60);box(document.querySelector('footer')!,355,500);const move=vi.fn();scroll.scrollBy=move;return {root,target,box,move};
}
describe('question focus visibility around pinned phone controls',()=>{
 it('lifts a custom reply above the composer, including its focus ring',()=>{const f=fixture();f.box(f.target,434,466);keepQuestionTargetVisible(f.root,f.target);expect(f.move).toHaveBeenCalledWith({top:119,behavior:'instant'});});
 it('reveals the next question header without scrolling a visible question',()=>{const f=fixture();f.box(f.root,43,332);f.box(f.target,91,111);keepQuestionTargetVisible(f.root,f.target,true);expect(f.move).toHaveBeenCalledWith({top:-25,behavior:'instant'});f.move.mockClear();f.box(f.root,193,482);f.box(f.target,241,261);keepQuestionTargetVisible(f.root,f.target,true);expect(f.move).not.toHaveBeenCalled();});
 it('does not move the document outside an app thread',()=>{const root=document.createElement('section'),target=document.createElement('input');root.append(target);expect(()=>keepQuestionTargetVisible(root,target)).not.toThrow();});
});
