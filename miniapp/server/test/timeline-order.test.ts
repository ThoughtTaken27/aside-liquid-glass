import {describe,expect,it} from 'vitest';import {parseHistory} from '../src/jsonl.js';import {buildThread} from '../src/thread.js';
const user={role:'user',content:'Review the example.',timestamp:1};
const ask={type:'toolCall',id:'question-call',name:'ask_user_question',arguments:{questions:[{header:'Route',question:'Which route?',options:[{label:'Local',description:''}]}]}};
const assistant=(timestamp:number,content:unknown[])=>({role:'assistant',timestamp,content});
const call=(id:string)=>({type:'toolCall',id,name:'bash',arguments:{command:id}});
const result=(id:string,timestamp:number)=>({role:'toolResult',toolCallId:id,timestamp,content:[{type:'text',text:'Done'}]});
const thread=(rows:unknown[],running=false)=>buildThread(parseHistory(rows.map(x=>JSON.stringify(x)).join('\n')),running);
const marker='[[QUESTION]]'+JSON.stringify({question:'Which route?',options:[{label:'Local'}]})+'[[/QUESTION]]';
describe('question transcript anchors',()=>{
 it('keeps an answered native question before later work and the answer',()=>{const items=thread([user,assistant(2,[call('before')]),result('before',3),assistant(4,[ask]),result('question-call',5),assistant(6,[call('after')]),result('after',7),assistant(8,[{type:'text',text:'Later answer.'}])]);expect(items.map(x=>x.kind)).toEqual(['user','work','question','work','answer']);expect(items.find(x=>x.kind==='question')).toMatchObject({status:'answered'});});
 it('preserves prose on each side of an inline soft question',()=>{const items=thread([user,assistant(2,[{type:'text',text:`Before question.\n${marker}\nAfter question.`}])]);const text=items.flatMap(x=>x.kind==='work'?x.items.map(w=>w.kind==='text'?w.text:'tool'):x.kind==='question'?['QUESTION']:x.kind==='answer'?[x.text]:[]);expect(text).toEqual(['Before question.','QUESTION','After question.']);});
 it('keeps the question identity while later content is appended',()=>{const rows=[user,assistant(2,[ask]),result('question-call',3)];const first=thread(rows).find(x=>x.kind==='question');const later=thread([...rows,assistant(4,[{type:'text',text:'Continuing after the question.'}])]);expect(later.find(x=>x.kind==='question')?.id).toBe(first?.id);expect(later.map(x=>x.kind)).toEqual(['user','question','answer']);});
 it('only marks the work after an answered question as still running',()=>{const items=thread([user,assistant(2,[call('before')]),result('before',3),assistant(4,[ask]),result('question-call',5),assistant(6,[call('after')])],true);const work=items.filter(x=>x.kind==='work');expect(work.map(x=>x.running)).toEqual([false,true]);});
 it('keeps existing tool/artifact ids when marker prose is split into two positions',()=>{const items=thread([user,assistant(2,[{type:'text',text:'Before.\n'+marker+'\nAfter.'},call('first-tool'),call('second-tool')])]);const ids=items.flatMap(x=>x.kind==='work'?x.items.filter(w=>w.kind==='step').map(w=>w.id):[]);expect(ids).toEqual(['s-1-1','s-1-2']);});
});
