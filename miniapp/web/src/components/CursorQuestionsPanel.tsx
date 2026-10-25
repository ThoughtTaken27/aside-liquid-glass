import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { haptic } from '../telegram';
import type { QuestionCardProps } from './QuestionCard';
import type { QuestionBlock, QuestionArtifact } from '../types';
import { changeQuestionDraft, forgetQuestionDraft, questionDraft, sendQuestionDraft, watchQuestionDraft, type QuestionAnswerDraft } from './questionDrafts';
import { keepQuestionTargetVisible } from './questionVisibility';
import '../theme/questions.css';
const SKIP_ALL = 'Skip these questions. No answers provided.';
function answerText(block: QuestionBlock, answer: QuestionAnswerDraft) {
  return [...answer.selected.map(i=>block.options[i]?.label).filter(Boolean),answer.custom.trim()].filter(Boolean).join('; ');
}
function identity(props: QuestionCardProps) {
  return `${props.cacheKey || props.item.id}:${props.item.source}:${props.item.answerable}:${JSON.stringify(props.item.questions)}`;
}
export function CursorQuestionsPanel(props: QuestionCardProps) {
  const key=identity(props);
  useEffect(()=>{if(props.item.status==='answered')forgetQuestionDraft(key);},[key,props.item.status]);
  if(props.item.status==='answered')return <QuestionReceipt answer={props.item.answer || 'Answered'} skipped={props.item.answer===SKIP_ALL} prompts={props.item.questions.map(q=>q.question)} artifact={props.item.artifact} />;
  return <PendingQuestions key={key} {...props} draftKey={key} />;
}
function PendingQuestions({item,onAnswer,onRecover,busy,draftKey}: QuestionCardProps & {draftKey:string}) {
  const recoverable=!item.answerable&&Boolean(onRecover), live=item.answerable&&Boolean(onAnswer);
  const subscribe=useCallback((listener:()=>void)=>watchQuestionDraft(draftKey,listener),[draftKey]);
  const snapshot=useCallback(()=>questionDraft(draftKey,item.questions.length,recoverable),[draftKey,item.questions.length,recoverable]);
  const draft=useSyncExternalStore(subscribe,snapshot,snapshot);
  const root=useRef<HTMLElement>(null),heading=useRef<HTMLParagraphElement>(null),customInput=useRef<HTMLInputElement>(null);
  const body=useRef<HTMLDivElement>(null),viewport=useRef<HTMLDivElement>(null),oldHeight=useRef(0),heightMotion=useRef<Animation|null>(null),bodyMotion=useRef<Animation|null>(null),focusNext=useRef(false),animateNext=useRef(false),notice=useId(),questionId=useId();
  const visibilityFrame=useRef<number|null>(null);
  // A tapped single choice shows as chosen for a beat before the next question
  // arrives, as in the reference panel; keyboard picks still advance at once.
  const advanceTimer=useRef<number|null>(null);
  const cancelAdvance=()=>{if(advanceTimer.current!==null){window.clearTimeout(advanceTimer.current);advanceTimer.current=null;}};
  const keepInputVisible=useCallback(()=>{
    if(visibilityFrame.current!==null)cancelAnimationFrame(visibilityFrame.current);
    visibilityFrame.current=requestAnimationFrame(()=>{visibilityFrame.current=null;if(document.activeElement===customInput.current)keepQuestionTargetVisible(root.current,customInput.current?.closest('.cq-custom') as HTMLElement|null);});
  },[]);
  useEffect(()=>{
    window.addEventListener('resize',keepInputVisible);window.visualViewport?.addEventListener('resize',keepInputVisible);
    return()=>{window.removeEventListener('resize',keepInputVisible);window.visualViewport?.removeEventListener('resize',keepInputVisible);if(visibilityFrame.current!==null)cancelAnimationFrame(visibilityFrame.current);};
  },[keepInputVisible]);
  const step=Math.min(draft.step,Math.max(0,item.questions.length-1)), block=item.questions[step];
  const current=draft.answers[step]??{selected:[],custom:''};
  const disabled=(!live&&!recoverable)||draft.phase!=='editing'||Boolean(busy)&&!recoverable;
  const last=step===item.questions.length-1;
  const answeredCount=item.questions.filter((b,i)=>answerText(b,draft.answers[i]??{selected:[],custom:''})).length;
  useEffect(()=>{
    if((live||recoverable)&&!draft.warned){changeQuestionDraft(draftKey,{...snapshot(),warned:true});haptic('warning');}
  },[draftKey,live,recoverable,draft.warned,snapshot]);
  useLayoutEffect(()=>{
    if(focusNext.current){heading.current?.focus({preventScroll:true});keepQuestionTargetVisible(root.current,heading.current,true);focusNext.current=false;}
    heightMotion.current?.cancel(); heightMotion.current=null; bodyMotion.current?.cancel(); bodyMotion.current=null;
    if(animateNext.current&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      bodyMotion.current=body.current?.animate?.([{opacity:0,transform:'translateY(6px)',filter:'blur(2px)'},{opacity:1,transform:'none',filter:'blur(0)'}],{duration:320,easing:'cubic-bezier(.22,1,.36,1)'})??null;
      const el=viewport.current;
      if(el?.animate&&oldHeight.current){
        const animation=el.animate([{height:oldHeight.current+'px'},{height:el.getBoundingClientRect().height+'px'}],{duration:360,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});
        heightMotion.current=animation;
        void animation.finished.then(()=>{if(heightMotion.current===animation){heightMotion.current=null;animation.cancel();}},()=>{});
      }
    }
    animateNext.current=false;
  },[step]);
  useEffect(()=>()=>{heightMotion.current?.cancel();bodyMotion.current?.cancel();cancelAdvance();},[]);
  const go=(next:number,animate:boolean)=>{
    cancelAdvance();
    if(draft.phase!=='editing')return;
    oldHeight.current=viewport.current?.getBoundingClientRect().height||0;
    focusNext.current=Boolean(root.current?.contains(document.activeElement));animateNext.current=animate;
    changeQuestionDraft(draftKey,{...snapshot(),step:Math.max(0,Math.min(item.questions.length-1,next)),error:null});
  };
  const pick=(index:number,animate:boolean)=>{
    if(disabled||!block)return;
    haptic('light');
    const value=block.multiple?{...current,selected:current.selected.includes(index)?current.selected.filter(i=>i!==index):[...current.selected,index].sort((a,b)=>a-b)}:{selected:[index],custom:''};
    const next={...snapshot(),answers:draft.answers.map((a,i)=>i===step?value:a),error:null};
    cancelAdvance();
    if(!block.multiple&&!last){
      if(animate&&!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){
        changeQuestionDraft(draftKey,next);
        const from=step;
        advanceTimer.current=window.setTimeout(()=>{
          advanceTimer.current=null;
          const now=questionDraft(draftKey,item.questions.length,recoverable);
          if(now.phase!=='editing'||now.step!==from)return;
          oldHeight.current=viewport.current?.getBoundingClientRect().height||0;
          focusNext.current=Boolean(root.current?.contains(document.activeElement));animateNext.current=true;
          changeQuestionDraft(draftKey,{...now,step:from+1,error:null});
        },260);
        return;
      }
      oldHeight.current=viewport.current?.getBoundingClientRect().height||0;focusNext.current=Boolean(root.current?.contains(document.activeElement));animateNext.current=false;next.step=step+1;
    }
    changeQuestionDraft(draftKey,next);
  };
  const send=(skip=false)=>{
    cancelAdvance();
    if(disabled)return;
    const answers=item.questions.map((b,i)=>answerText(b,draft.answers[i]??{selected:[],custom:''}));
    if(!skip&&!recoverable&&!answers.some(Boolean))return;
    const header=item.questions.length===1&&!skip?item.questions[0].header:'';
    const headings=item.questions.map((b,i)=>b.header||`Question ${i+1}`);
    const label=skip?SKIP_ALL:item.questions.length===1?answers[0]:item.questions.map((_,i)=>{const heading=headings.filter(h=>h===headings[i]).length>1?`${headings[i]} (question ${i+1})`:headings[i];return `${heading}: ${answers[i]||'No answer provided.'}`;}).join('\n');
    const recoverLabel=answers.some(Boolean)?(header?`${header}: ${label}`:label):'';
    haptic('light');
    void sendQuestionDraft(draftKey,label,skip,()=>recoverable?onRecover!(item.questions.length===1?answers[0]:recoverLabel):onAnswer!(header,label));
  };
  const next=(animate:boolean)=>{if(last)send();else go(step+1,animate);};
  const keyDown=(event:KeyboardEvent<HTMLElement>)=>{
    root.current?.setAttribute('data-keyboard','');
    if(draft.phase!=='editing'||event.nativeEvent.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.repeat&&(event.key==='Enter'||/^[1-9]$/.test(event.key))){event.preventDefault();return;}
    const typing=event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement||(event.target instanceof HTMLElement&&event.target.isContentEditable);
    if(event.key==='Enter'&&(typing||event.target===heading.current)){event.preventDefault();next(false);return;}
    if(typing)return;
    if(/^[1-9]$/.test(event.key)){
      const index=Number(event.key)-1;
      if(index<block.options.length){event.preventDefault();pick(index,false);}
      else if(index===block.options.length&&block.allowOther!==false){event.preventDefault();customInput.current?.focus();}
    } else if(event.key==='ArrowLeft'&&step>0){event.preventDefault();go(step-1,false);}
    else if(event.key==='ArrowRight'&&!last){event.preventDefault();go(step+1,false);}
    else if(event.key==='ArrowUp'||event.key==='ArrowDown'){
      const rows=Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.cq-option-button:not(:disabled)')||[]),index=rows.indexOf(document.activeElement as HTMLButtonElement);
      if(rows.length){event.preventDefault();rows[(index+(event.key==='ArrowDown'?1:-1)+rows.length)%rows.length].focus();}
    }
  };
  if(draft.phase==='sent')return <QuestionReceipt count={answeredCount} answer={draft.submitted} skipped={draft.skipped} recovered={recoverable} prompts={item.questions.map(q=>q.question)} artifact={item.artifact} />;
  if(!block)return null;
  return <section ref={root} className="cursor-questions" data-card-group="utility" data-card-kind="question" data-card-state={live||recoverable?'actionable':'readonly'} aria-label="Questions" aria-busy={draft.phase==='sending'} onKeyDown={keyDown} onPointerDown={()=>root.current?.removeAttribute('data-keyboard')}>
    <PanelHeader progress={`${step+1} of ${item.questions.length}`} />
    <div ref={viewport} className="cq-viewport"><div className="cq-content">
      <div ref={body} className="cq-page" data-question-index={step}>
        <div className="cq-question"><p ref={heading} id={questionId} tabIndex={-1}>{block.question}</p>{block.multiple?<span>Pick any that apply.</span>:null}</div>
        <div className="cq-options" role="group" aria-labelledby={questionId} aria-describedby={!item.answerable||!onAnswer?notice:undefined}>
          {block.options.map((option,index)=><button key={`${index}:${option.label}`} type="button" className="cq-option cq-option-button" aria-label={option.label} aria-describedby={option.description?`${questionId}-option-${index}-description`:undefined} aria-pressed={current.selected.includes(index)} aria-keyshortcuts={index<9?String(index+1):undefined} data-selected={current.selected.includes(index)?'':undefined} disabled={disabled} onClick={e=>pick(index,e.detail>0)}>
            <span className="cq-number" aria-hidden="true">{index+1}</span><span className="cq-option-copy"><span>{option.label}</span>{option.description?<small id={`${questionId}-option-${index}-description`}>{option.description}</small>:null}</span>
          </button>)}
          {block.allowOther!==false||!block.options.length?<label className="cq-option cq-custom" data-selected={current.custom.trim()?'':undefined}>
            <span className="cq-number" aria-hidden="true">{block.options.length+1}</span>
            <input ref={customInput} type="text" autoComplete="off" onFocus={keepInputVisible} value={current.custom} disabled={disabled} aria-label={`${block.otherLabel||'Something else'}: ${block.question}`} aria-keyshortcuts={block.options.length<9?String(block.options.length+1):undefined} placeholder={block.otherLabel||'Something else'} onChange={e=>{
              const value={selected:block.multiple?current.selected:[],custom:e.target.value};changeQuestionDraft(draftKey,{...snapshot(),answers:draft.answers.map((a,i)=>i===step?value:a),error:null});
            }} />
          </label>:null}
        </div>
      </div>
      {item.artifact?<dl className="cq-artifact">{item.artifact.summary.map((row,i)=><div key={`${i}:${row.label}`}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>:null}
      {!item.answerable||!onAnswer?<p className="cq-notice" id={notice}>{recoverable?'This request is waiting on Aside on your computer. Your answers will continue in a new session; the original chat stays saved.':!item.answerable?'Respond from Aside on your computer. This request cannot be answered from mobile.':'This question is read-only in this view.'}</p>:null}
      {draft.error?<p className="cq-error" role="alert">{draft.error}</p>:null}
      <div className="cq-footer">
        <span className="cq-secondary">{step>0?<button type="button" disabled={draft.phase!=='editing'} onClick={e=>go(step-1,e.detail>0)} aria-keyshortcuts="ArrowLeft">Back</button>:null}{live?<button type="button" disabled={disabled} onClick={()=>send(true)}>Skip all</button>:null}</span>
        <button type="button" className="cq-next" disabled={draft.phase!=='editing'||last&&(disabled||!recoverable&&!answeredCount)} onClick={e=>next(e.detail>0)}>{draft.phase==='sending'?'Sending…':last?!live&&!recoverable?!item.answerable?'Answer on computer':'Read only':recoverable?'Continue in a new session':'Submit':'Next'}<kbd aria-hidden="true">↵</kbd></button>
      </div>
    </div></div>
  </section>;
}
function PanelHeader({progress}: {progress:string}) {
  return <div className="cq-header"><span className="cq-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 20.5C19.1328 20.5 22 16.4706 22 11.5C22 6.52944 20.1328 2.5 12 2.5C4.13281 2.5 2 6.52944 2 11.5C2 13.5712 2.37034 15.4791 3.37161 17C4.63281 19 3.99253 20.8333 3 21.5C4.61547 21.5 5.70211 20.9858 6.39239 20.4766C6.88252 20.115 7.50688 19.9364 8.0984 20.0815C9.20689 20.3533 10.4991 20.5 12 20.5Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M10 9C10 7.89543 10.8954 7 12 7C13.1046 7 14 7.89543 14 9C14 9.57777 13.755 10.0983 13.3632 10.4634C12.7572 11.0282 12 11.6716 12 12.5M12.125 15.75H12M12.25 15.75C12.25 15.8881 12.1381 16 12 16C11.8619 16 11.75 15.8881 11.75 15.75C11.75 15.6119 11.8619 15.5 12 15.5C12.1381 15.5 12.25 15.6119 12.25 15.75Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span className="cq-title">Questions</span><span className="cq-progress">{progress}</span></div>;
}
function QuestionReceipt({count,answer,skipped,recovered=false,prompts=[],artifact}: {count?:number;answer:string;skipped:boolean;recovered?:boolean;prompts?:string[];artifact?:QuestionArtifact}) {
  const [open,setOpen]=useState(false),id=useId();
  return <section className="cursor-questions cq-receipt" data-card-group="utility" data-card-kind="question" data-card-state="settled" aria-label="Questions"><button type="button" className="cq-receipt-toggle" aria-expanded={open} aria-controls={id} aria-label={`Questions. ${recovered?'Continued in a new session':skipped?'Skipped':count===undefined?'Answered':`${count} answered`}. ${open?'Hide':'Show'} answers.`} onClick={()=>setOpen(v=>!v)}><PanelHeader progress={recovered?'Continued':skipped?'Skipped':count===undefined?'Answered':`${count} answered`} /></button><div className="craft-fold cq-receipt-fold" data-open={open?'':undefined} inert={!open}><div><div id={id} className="cq-receipt-answer">{prompts.length?<p className="cq-history-questions">{prompts.join('\n')}</p>:null}{artifact?<dl className="cq-artifact">{artifact.summary.map((row,i)=><div key={`${i}:${row.label}`}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>:null}{answer||'No answer provided.'}</div></div></div></section>;
}
