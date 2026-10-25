import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildParentView, slimChildStep, type ThreadStore, type ThreadSnapshot } from '../src/threadstore.js';
import { toChildSession } from '../src/subagents.js';
import type { ChildSession, WorkStep } from '../src/thread.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const child = (id: string, call = id): ChildSession => ({id,title:id,status:'running',toolCallId:call,modelLabel:null,running:true});
const step = (id: string, spawn?: ChildSession): WorkStep => ({kind:'step',id,icon:'search',label:id,tool:spawn?'subagent':'websearch',status:'success',diffstat:null,detail:{output:'PRIVATE TOOL OUTPUT'},images:['private.png'],...(spawn?{subagent:{callId:spawn.toolCallId,description:spawn.title,prompt:'Inspect the public source',hue:0,child:spawn}}:{})});
const snapshot = (steps: WorkStep[], tokens=500): ThreadSnapshot => ({items:[{kind:'work',id:'work',items:steps,running:true,durationMs:1000},{kind:'answer',id:'answer',text:'A'.repeat(2000),ts:1}],stats:{totalTokens:tokens,turnTokens:tokens,turnStartedAt:1},sources:{},subagents:[],todos:[]});
describe('subagent tree payload',()=>{
  it('preserves real daemon times without inventing missing times',()=>{
    const base={id:'a',title:'A',status:'idle',toolCallId:'call',model:null,createdAt:1000,updatedAt:9000};
    expect(toChildSession(base,()=>'' )).toMatchObject({createdAt:1000,updatedAt:9000});
    expect(toChildSession({...base,createdAt:0,updatedAt:0},()=>'' )).not.toHaveProperty('createdAt');
  });
  it('retains ownership but does not send tool output or images',()=>{
    const slim=slimChildStep(step('spawn',child('kid')));
    expect(slim.subagent?.child?.id).toBe('kid');expect(slim.detail).toBeNull();expect(slim.images).toEqual([]);
  });
  it('keeps nested spawns after the twelve-step tail advances, with usage and bounded summaries',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'aside-tree-'));roots.push(root);
    for(const id of ['parent','kid','grand']){fs.mkdirSync(path.join(root,`2026_${id}`));fs.writeFileSync(path.join(root,`2026_${id}`,'messages.jsonl'),'');}
    const kid=child('kid'), grand=child('grand');const builds: Record<string,ThreadSnapshot>={parent:snapshot([]),kid:snapshot([step('spawn',grand),...Array.from({length:20},(_,i)=>step(`tool${i}`))],8200),grand:snapshot([step('verify')],2100)};
    const fake={build:(id:string)=>builds[id],keyOf:()=> 'revision'} as unknown as ThreadStore;
    const view=buildParentView(fake,root,'parent',path.join(root,'2026_parent/messages.jsonl'),true,{children:[kid],stamp:'kid'},id=>({children:id==='kid'?[grand]:[],stamp:id}));
    expect(view.children).toHaveLength(2);expect(view.children[0].steps).toHaveLength(12);
    expect(view.children[0].spawns?.[0].child?.id).toBe('grand');expect(view.children[0].tokens).toBe(8200);
    expect(view.children[0].summary).toHaveLength(1200);expect(view.children[1].tokens).toBe(2100);
  });
  it('does not recurse into a repeated child identity',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'aside-tree-cycle-'));roots.push(root);
    fs.mkdirSync(path.join(root,'2026_kid'));fs.writeFileSync(path.join(root,'2026_kid/messages.jsonl'),'');const kid=child('kid');let reads=0;
    const fake={build:()=>{reads++;return snapshot([]);},keyOf:()=> 'revision'} as unknown as ThreadStore;
    const view=buildParentView(fake,root,'parent','unused',true,{children:[kid],stamp:'kid'},()=>({children:[kid],stamp:'loop'}));
    expect(view.children).toHaveLength(1);expect(reads).toBe(2);
  });
});
