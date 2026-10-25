/** In-memory only: draft answers never enter storage or a request before Submit. */
export interface QuestionAnswerDraft { selected: number[]; custom: string }
export interface QuestionDraft {
  step: number;
  answers: QuestionAnswerDraft[];
  phase: 'editing' | 'sending' | 'sent';
  submitted: string;
  skipped: boolean;
  error: string | null;
  warned: boolean;
}
const drafts = new Map<string, QuestionDraft>();
const listeners = new Map<string, Set<() => void>>();
const flights = new Map<string, Promise<void>>();
const recoveryKeys = new Set<string>();
const forgetAfterFlight = new Set<string>();
function prune() {
  for (const key of drafts.keys()) {
    if (drafts.size <= 32) break;
    if (!listeners.get(key)?.size && !flights.has(key)) { drafts.delete(key); recoveryKeys.delete(key); }
  }
}
export function questionDraft(key: string, count: number, recovery: boolean): QuestionDraft {
  if (recovery) recoveryKeys.add(key);
  let draft = drafts.get(key);
  if (!draft) {
    draft = { step: 0, answers: Array.from({length: count},()=>({selected:[],custom:''})),phase:'editing',submitted:'',skipped:false,error:null,warned:false };
    drafts.set(key,draft); prune();
  }
  return draft;
}
export function watchQuestionDraft(key: string, listener: () => void) {
  const set = listeners.get(key) ?? new Set<() => void>(); set.add(listener); listeners.set(key,set);
  return () => { set.delete(listener); if (!set.size) { listeners.delete(key); if (recoveryKeys.has(key) && drafts.get(key)?.phase === 'sent') forgetQuestionDraft(key); } };
}
export function changeQuestionDraft(key: string, next: QuestionDraft) {
  drafts.delete(key); drafts.set(key,next); listeners.get(key)?.forEach(fn=>fn()); prune();
}
export function forgetQuestionDraft(key: string) {
  if (flights.has(key)) { forgetAfterFlight.add(key); return; }
  drafts.delete(key); recoveryKeys.delete(key);
}
export function sendQuestionDraft(key: string, text: string, skipped: boolean, action: () => Promise<void> | void): Promise<void> {
  const prior = flights.get(key); if (prior) return prior;
  const current = drafts.get(key); if (!current || current.phase !== 'editing') return Promise.resolve();
  changeQuestionDraft(key,{...current,phase:'sending',error:null});
  const request = Promise.resolve().then(action).then(()=>{
    const latest=drafts.get(key); if(latest) changeQuestionDraft(key,{...latest,phase:'sent',submitted:text,skipped,error:null});
  },()=>{
    const latest=drafts.get(key); if(latest) changeQuestionDraft(key,{...latest,phase:'editing',error:'Your reply was not confirmed. Try again; your answers are still here.'});
  }).finally(()=>{
    flights.delete(key);
    if(forgetAfterFlight.delete(key)){forgetQuestionDraft(key);return;}
    if(recoveryKeys.has(key)&&!listeners.get(key)?.size&&drafts.get(key)?.phase==='sent') forgetQuestionDraft(key);
  });
  flights.set(key,request); return request;
}
