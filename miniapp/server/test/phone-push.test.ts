import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhonePush, parseSubscription, pushPayload, type PushNotice } from '../src/push.js';
import { PushMonitor, type PushSession } from '../src/push-monitor.js';
import { registerPhonePushRoutes } from '../src/push-routes.js';
const roots: string[] = [];
const root = () => { const p=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-push-'));roots.push(p);return p; };
function subscription(suffix = 'synthetic') { const ec=crypto.createECDH('prime256v1'); ec.generateKeys(); return { endpoint: 'https://fcm.googleapis.com/fcm/send/'+suffix, keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')} }; }
afterEach(() => roots.splice(0).forEach(p=>fs.rmSync(p,{recursive:true,force:true})));
describe('encrypted push boundary and private defaults', () => {
  it.each(['http://fcm.googleapis.com/send/a','https://127.0.0.1/a','https://example.com/a','https://fcm.googleapis.com.evil.test/a','https://fcm.googleapis.com:444/a','https://u:p@fcm.googleapis.com/a','https://fcm.googleapis.com/a#x'])('rejects SSRF endpoint %s', endpoint=>{ expect(()=>parseSubscription({...subscription(),endpoint})).toThrow(); });
  it.each([null,{}, {keys:{p256dh:'x',auth:'x'}}])('rejects malformed subscription', s=>expect(()=>parseSubscription(s)).toThrow());
  it('accepts only well-shaped public curve keys and strips untrusted fields',()=>{ const s=subscription();expect(parseSubscription({...s,private:'ignore'})).toEqual(s);expect(()=>parseSubscription({...s,keys:{...s.keys,p256dh:Buffer.alloc(65).toString('base64url')}})).toThrow(); });
  it('keeps title and reply out of default previews, excludes credentials from payload',()=>{ const p=pushPayload({kind:'ready',sessionId:'Synthetic_Thread',title:'Private title',summary:'Secret reply'},{previews:false,progress:false},100);expect(JSON.stringify(p)).not.toMatch(/Private|Secret|token|endpoint|auth|keys/);expect(p).toMatchObject({title:'Reply ready',sessionId:'Synthetic_Thread',expiresAt:3_600_100}); });
  it('cleans and truncates opted-in summaries, expires progress quickly',()=>{ const p=pushPayload({kind:'progress',title:'<b>Demo</b>',summary:'```js\nsecret\n```\n[read](https://example.com) '+ 'x'.repeat(240)},{previews:true,progress:true},100);expect(p.title).toBe('Aside is working');expect(p.topic).toBe('Demo');expect(p.body.length).toBeLessThanOrEqual(200);expect(p.body).not.toContain('secret');expect(p.expiresAt).toBe(120_100); });
  it('persists signing identity and device preferences with owner-only files',()=>{const dir=root(),a=new PhonePush({stateDir:dir});expect(fs.existsSync(path.join(dir,'phone-push-vapid.json'))).toBe(false);const key=a.publicKey,d=a.subscribe(subscription());a.update(d.id,{previews:true});const b=new PhonePush({stateDir:dir});expect(b.publicKey).toBe(key);expect(b.get(d.id)?.preferences).toEqual({previews:true,progress:true});for(const name of ['phone-push-vapid.json','phone-push-devices.json'])expect(fs.statSync(path.join(dir,name)).mode&0o777).toBe(0o600);expect(JSON.stringify(a.get(d.id))).not.toContain('endpoint');});
  it('updates one endpoint instead of duplicating it and keeps preferences on reconnection',()=>{const p=new PhonePush({stateDir:root()}),s=subscription(),d=p.subscribe(s,{previews:true,progress:true});expect(p.subscribe(s)).toEqual(d);expect(p.count).toBe(1);});
  it('does not initialize signing keys or network before opt-in',async()=>{const send=vi.fn(),dir=root(),p=new PhonePush({stateDir:dir,send});expect(await p.deliver({kind:'ready'})).toEqual({accepted:0,failed:0});expect(send).not.toHaveBeenCalled();expect(fs.existsSync(path.join(dir,'phone-push-vapid.json'))).toBe(false);});
  it('sends live status by default unless turned off, collapses a thread, removes expired devices but retains transient failures',async()=>{const send=vi.fn().mockResolvedValue({}),p=new PhonePush({stateDir:root(),send});const a=p.subscribe(subscription('a')),b=p.subscribe(subscription('b'),{progress:true});p.subscribe(subscription('c'),{progress:false});expect(await p.deliver({kind:'progress',sessionId:'thread'})).toEqual({accepted:2,failed:0});expect(send.mock.calls[0][2]).toMatchObject({TTL:120,urgency:'low'});expect(send.mock.calls[0][2].topic).toHaveLength(32);send.mockReset().mockRejectedValueOnce({statusCode:410}).mockRejectedValueOnce({statusCode:503});expect(await p.deliver({kind:'ready'})).toEqual({accepted:1,failed:2});expect(p.get(a.id)).toBeNull();expect(p.get(b.id)).not.toBeNull();});
  it('ignores invalid records instead of failing background scans',()=>{const dir=root();fs.writeFileSync(path.join(dir,'phone-push-devices.json'),JSON.stringify([{id:'bad',subscription:subscription()}]));expect(new PhonePush({stateDir:dir}).count).toBe(0);});
});
describe('status monitor without replay or model calls',()=>{
  function rig(){let rows:PushSession[]|null=[],now=0,enabled=true;const send=vi.fn(async(_notice:PushNotice)=>{}),detail=vi.fn(async()=> 'Synthetic summary');const m=new PushMonitor({enabled:()=>enabled,sessions:async()=>rows,now:()=>now,send,detail});return{m,send,detail,rows:(r:PushSession[]|null)=>{rows=r;},time:(n:number)=>{now=n;},enabled:(e:boolean)=>{enabled=e;}};}
  const row=(status:string):PushSession=>({id:'synthetic',title:'Test thread',status,updatedAt:1});
  it('baselines history, emits one completion and one question, not user stops',async()=>{const r=rig();r.rows([row('idle')]);await r.m.tick();expect(r.send).not.toHaveBeenCalled();r.rows([row('running')]);await r.m.tick();r.rows([row('suspended')]);await r.m.tick();await r.m.tick();expect(r.send).toHaveBeenCalledTimes(1);expect(r.send.mock.calls[0][0]).toMatchObject({kind:'needs-input'});r.rows([row('running')]);await r.m.tick();r.rows([row('idle')]);await r.m.tick();expect(r.send.mock.calls[1][0]).toMatchObject({kind:'ready'});r.rows([row('running')]);await r.m.tick();r.rows([row('interrupted')]);await r.m.tick();expect(r.send).toHaveBeenCalledTimes(2);});
  it('keeps local turns shorter than a scan, emits failures, no prior completion flood',async()=>{const r=rig();r.m.begin('synthetic',0);r.rows([row('error')]);await r.m.tick();expect(r.send.mock.calls[0][0]).toMatchObject({kind:'error'});await r.m.tick();expect(r.send).toHaveBeenCalledTimes(1);});
  it('sends live status after 10 s, follows phase changes at most every 15 s, heartbeats, never reads content',async()=>{
    let now=0,phase='Searching the web';const send=vi.fn(async(_n:PushNotice)=>{}),detail=vi.fn(async()=>'x');
    const m=new PushMonitor({enabled:()=>true,sessions:async()=>[row('running')],now:()=>now,send,detail,phase:async()=>phase});
    await m.tick();now=9_999;await m.tick();expect(send).not.toHaveBeenCalled();
    now=10_000;await m.tick();expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0]).toMatchObject({kind:'progress',phase:'Searching the web',startedAt:0});
    now=15_000;await m.tick();expect(send).toHaveBeenCalledTimes(1);
    phase='Running a command';now=20_000;await m.tick();expect(send).toHaveBeenCalledTimes(1);
    now=25_000;await m.tick();expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[1][0]).toMatchObject({phase:'Running a command',startedAt:0});
    now=25_000+239_999;await m.tick();expect(send).toHaveBeenCalledTimes(2);
    now=25_000+240_000;await m.tick();expect(send).toHaveBeenCalledTimes(3);
    expect(detail).not.toHaveBeenCalled();
  });
  it('keeps live status private: the phase word replaces the body, never the summary',()=>{const p=pushPayload({kind:'progress',sessionId:'s',title:'Private title',summary:'Secret',phase:'Browsing the web',startedAt:5},{previews:false,progress:true},100);expect(p).toMatchObject({title:'Aside is working',body:'Browsing the web',phase:'Browsing the web',startedAt:5});expect(JSON.stringify(p)).not.toMatch(/Private|Secret/);});
  it('catches between-scan Mac turns using fresh final-answer evidence, not title updates',async()=>{
    let now=100, rows:PushSession[]=[{...row('idle'),updatedAt:90}],finalAt:number|null=90;
    const send=vi.fn(async(_n:PushNotice)=>{}),m=new PushMonitor({enabled:()=>true,sessions:async()=>rows,now:()=>now,send,finalAnswerAt:async()=>finalAt});
    await m.tick();now=200;rows=[{...row('idle'),updatedAt:190}];await m.tick();expect(send).not.toHaveBeenCalled();
    now=300;rows=[{...row('idle'),updatedAt:290}];finalAt=280;await m.tick();expect(send.mock.calls[0][0].kind).toBe('ready');await m.tick();expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not repeat an observed completion when the daemon update settles later',async()=>{
    let now=50,rows:PushSession[]=[{...row('running'),updatedAt:60}];const send=vi.fn(async(_n:PushNotice)=>{});
    const m=new PushMonitor({enabled:()=>true,sessions:async()=>rows,send,now:()=>now,finalAnswerAt:async()=>95});
    await m.tick();now=100;rows=[{...row('idle'),updatedAt:90}];await m.tick();now=120;rows=[{...row('idle'),updatedAt:110}];await m.tick();expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not mistake a database outage for completion or replay after opting out',async()=>{const r=rig();r.rows([row('running')]);await r.m.tick();r.rows(null);await r.m.tick();expect(r.send).not.toHaveBeenCalled();r.enabled(false);await r.m.tick();r.enabled(true);r.rows([row('idle')]);await r.m.tick();expect(r.send).not.toHaveBeenCalled();});
});
describe('authenticated settings and idempotent safe replies',()=>{
  async function appRig(reply=vi.fn(async()=>{})){const app=Fastify(),push=new PhonePush({stateDir:root(),send:vi.fn().mockResolvedValue({})});registerPhonePushRoutes(app,{push,reply,auth:async(req,res)=>{if(req.headers.authorization!=='Bearer synthetic')return res.code(401).send({error:'unauthorized'});}});await app.ready();return{app,push,reply};}
  const headers={authorization:'Bearer synthetic'},payload={sessionId:'Synthetic_Thread',text:'Hello',requestId:'12345678-1234-4234-8234-123456789012'};
  it('protects every notification path and cannot initialize keys unauthenticated',async()=>{const{app,push,reply}=await appRig();try{for(const [method,url]of [['GET','/api/notifications/config'],['POST','/api/notifications/subscribe'],['GET','/api/notifications/devices/test'],['PATCH','/api/notifications/devices/test'],['DELETE','/api/notifications/devices/test'],['POST','/api/notifications/devices/test/test'],['POST','/api/notifications/reply']]as const){expect((await app.inject({method,url,...(method==='POST'||method==='PATCH'?{payload:{}}:{})})).statusCode).toBe(401);}expect(push.count).toBe(0);expect(reply).not.toHaveBeenCalled();}finally{await app.close();}});
  it('rejects injected session ids, oversized text, blank replies and conflicting ids',async()=>{const{app,reply}=await appRig();try{for(const patch of[{sessionId:'--danger'}, {sessionId:'thread;rm'}, {sessionId:'../thread'}, {text:' '}, {text:'a'.repeat(32_001)}, {requestId:'bad'}])expect((await app.inject({method:'POST',url:'/api/notifications/reply',headers,payload:{...payload,...patch}})).statusCode).toBe(400);expect(reply).not.toHaveBeenCalled();expect((await app.inject({method:'POST',url:'/api/notifications/reply',headers,payload})).statusCode).toBe(200);expect((await app.inject({method:'POST',url:'/api/notifications/reply',headers,payload:{...payload,text:'Different'}})).statusCode).toBe(409);}finally{await app.close();}});
  it('shares concurrent receipts, returns accepted only after the runner, does not leak failures',async()=>{let finish!:()=>void;const reply=vi.fn(()=>new Promise<void>(r=>{finish=r;})),{app}=await appRig(reply);try{const a=app.inject({method:'POST',url:'/api/notifications/reply',headers,payload}),b=app.inject({method:'POST',url:'/api/notifications/reply',headers,payload});await vi.waitFor(()=>expect(reply).toHaveBeenCalledTimes(1));finish();expect((await a).json()).toEqual({accepted:true});expect((await b).json()).toEqual({accepted:true});reply.mockRejectedValueOnce(new Error('PRIVATE PATH OR TOKEN'));const failure=await app.inject({method:'POST',url:'/api/notifications/reply',headers,payload:{...payload,requestId:crypto.randomUUID()}});expect(failure.statusCode).toBe(409);expect(failure.body).not.toContain('PRIVATE');}finally{await app.close();}});
});
