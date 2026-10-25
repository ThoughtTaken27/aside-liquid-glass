import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source=fs.readFileSync(new URL('../../web/public/notification-worker.js',import.meta.url),'utf8');
function rig(){
  const handlers:Record<string,Function>={},drafts=new Map<string,unknown>(),notifications:unknown[]=[];
  const showNotification=vi.fn(async(title,options)=>{notifications.push({title,options});}),openWindow=vi.fn(async()=>null),matchAll=vi.fn(async()=>[] as unknown[]),fetch=vi.fn(async(_url: unknown,_init: any)=>({ok:true,json:async()=>({accepted:true})}));
  const indexedDB={open:()=>{const req:any={};setTimeout(()=>{req.result={createObjectStore:()=>{},close:()=>{},transaction:()=>{const tx:any={objectStore:()=>({put:(v:unknown,k:string)=>{drafts.set(k,v);const r={result:k};setTimeout(()=>tx.oncomplete?.(),0);return r;},get:(k:string)=>{const r={result:drafts.get(k)};setTimeout(()=>tx.oncomplete?.(),0);return r;},delete:(k:string)=>{drafts.delete(k);const r={result:undefined};setTimeout(()=>tx.oncomplete?.(),0);return r;}})};return tx;}};req.onsuccess?.();},0);return req;}};
  class Channel{port1:any={close:()=>{},onmessage:null};port2:any={postMessage:(data:unknown)=>this.port1.onmessage?.({data})};}
  const shown:any[]=[];const getNotifications=vi.fn(async({tag}:{tag:string})=>shown.filter(n=>n.tag===tag));showNotification.mockImplementation(async(title:string,options:any)=>{notifications.push({title,options});const old=shown.findIndex(x=>x.tag===options.tag);if(old>=0)shown.splice(old,1);const n:any={tag:options.tag,title,data:options.data,close:vi.fn(()=>{const i=shown.indexOf(n);if(i>=0)shown.splice(i,1);})};shown.push(n);});
  const self={location:{origin:'https://synthetic-app.test'},registration:{showNotification,getNotifications},clients:{matchAll,openWindow},addEventListener:(name:string,fn:Function)=>{handlers[name]=fn;}};
  vm.runInNewContext(source,{self,URL,URLSearchParams,Date,Set,Promise,MessageChannel:Channel,setTimeout,clearTimeout,indexedDB,fetch,AbortController,Number});
  async function event(name:string,extra:Record<string,unknown>){let result:Promise<unknown>|undefined;handlers[name]({...extra,waitUntil:(p:Promise<unknown>)=>{result=p;}});await result;}
  return{event,drafts,notifications,showNotification,openWindow,matchAll,fetch,shown};
}
const notice=()=>({version:1,id:'12345678-1234-4234-8234-123456789012',sessionId:'Synthetic_Thread',kind:'ready',title:'Reply ready',body:'Open your conversation to see the reply.',expiresAt:Date.now()+60_000});
describe('actual background-worker code',()=>{
  it('shows one session-tagged notification, safe text action and exact-thread tap',async()=>{const r=rig(),p=notice(),close=vi.fn();await r.event('push',{data:{json:()=>p}});expect(r.showNotification).toHaveBeenCalledWith('Reply ready',expect.objectContaining({tag:'aside',data:expect.objectContaining({sessionId:p.sessionId,id:p.id}),actions:expect.arrayContaining([expect.objectContaining({action:'reply',type:'text'})])}));expect(r.showNotification.mock.calls[0][1].icon).toBe('/icons/notification-blank.png');await r.event('notificationclick',{notification:{data:p,close},action:'open'});expect(r.openWindow).toHaveBeenCalledWith('https://synthetic-app.test/app#session=Synthetic_Thread');expect(r.fetch).not.toHaveBeenCalled();expect(close).toHaveBeenCalled();});
  it('drops expired/malformed pushes and does not expose reply for decisions',async()=>{const r=rig();for(const p of[{...notice(),expiresAt:0},{...notice(),sessionId:'../injected'},{...notice(),kind:'unknown'}])await r.event('push',{data:{json:()=>p}});expect(r.showNotification).not.toHaveBeenCalled();await r.event('push',{data:{json:()=>({...notice(),kind:'needs-input'})}});expect(r.showNotification.mock.calls[0][1].actions).toEqual([{action:'open',title:'Answer'}]);});
  it('acknowledges the foreground banner but still satisfies userVisibleOnly quietly',async()=>{const r=rig(),postMessage=vi.fn((m,ports)=>ports[0].postMessage({shown:true}));r.matchAll.mockResolvedValue([{url:'https://synthetic-app.test/app',visibilityState:'visible',postMessage}]);await r.event('push',{data:{json:notice}});expect(postMessage).toHaveBeenCalledTimes(1);expect(r.showNotification.mock.calls[0][1]).toMatchObject({silent:true,renotify:false});});
  it('sends an inline reply once using the session cookie, saves before network then removes on acceptance',async()=>{const r=rig(),p=notice();r.fetch.mockImplementationOnce(async()=>{expect(r.drafts.get(p.sessionId)).toMatchObject({text:'Hello',requestId:p.id});return{ok:true,json:async()=>({accepted:true})};});await r.event('notificationclick',{notification:{data:p,close:vi.fn()},action:'reply',reply:' Hello '});expect(r.fetch).toHaveBeenCalledTimes(1);expect(r.fetch.mock.calls[0][1]).toMatchObject({credentials:'include',method:'POST'});expect(r.fetch.mock.calls[0][1].headers).not.toHaveProperty('authorization');expect(JSON.parse(r.fetch.mock.calls[0][1].body)).toEqual({sessionId:p.sessionId,text:'Hello',requestId:p.id});expect(r.drafts.has(p.sessionId)).toBe(false);expect(r.showNotification.mock.calls[0][0]).toBe('Aside is working');expect(r.showNotification.mock.calls[0][1]).toMatchObject({tag:'aside',silent:true,body:'Message sent'});});
  it('retains an uncertain reply and opens the exact thread with a recoverable draft, never retries',async()=>{const r=rig(),p=notice();r.fetch.mockRejectedValueOnce(new Error('offline'));await r.event('notificationclick',{notification:{data:p,close:vi.fn()},action:'reply',reply:'Keep this draft'});expect(r.fetch).toHaveBeenCalledTimes(1);expect(r.drafts.get(p.sessionId)).toMatchObject({text:'Keep this draft'});const recovery=r.showNotification.mock.calls[0][1].data;expect(recovery.replyDraft).toBe(true);expect(r.showNotification.mock.calls[0][0]).toBe('Reply not confirmed');await r.event('notificationclick',{notification:{data:recovery,close:vi.fn()},action:'open'});expect(r.openWindow).toHaveBeenCalledWith('https://synthetic-app.test/app#session=Synthetic_Thread&notificationReply=1');});
  it('blank text actions open the conversation rather than launching a turn',async()=>{const r=rig();await r.event('notificationclick',{notification:{data:notice(),close:vi.fn()},action:'reply',reply:'  '});expect(r.fetch).not.toHaveBeenCalled();expect(r.openWindow).toHaveBeenCalled();});
  it('focuses and navigates an existing app window and ignores foreign draft requests',async()=>{const r=rig(),navigate=vi.fn(async()=>{}),focus=vi.fn(async()=>{}),postMessage=vi.fn();r.matchAll.mockResolvedValue([{url:'https://synthetic-app.test/app',navigate,focus}]);await r.event('notificationclick',{notification:{data:notice(),close:vi.fn()},action:'open'});expect(navigate).toHaveBeenCalledWith('https://synthetic-app.test/app#session=Synthetic_Thread');expect(focus).toHaveBeenCalled();expect(r.openWindow).not.toHaveBeenCalled();await r.event('message',{source:{url:'https://evil.test/'},data:{type:'aside:notification-draft',sessionId:'Synthetic_Thread'},ports:[{postMessage}]});expect(postMessage).not.toHaveBeenCalled();});
  it('one card: live status updates in place silently, then the same card rings with the reply',async()=>{
    const r=rig(),live={...notice(),kind:'progress',title:'Aside is working',body:'Searching the web',phase:'Searching the web',startedAt:1234};
    await r.event('push',{data:{json:()=>live}});
    expect(r.showNotification.mock.calls[0]).toEqual(['Aside is working',expect.objectContaining({tag:'aside',body:'Searching the web',silent:true,renotify:false,timestamp:1234,actions:[]})]);
    await r.event('push',{data:{json:()=>({...live,body:'Running a command',phase:'Running a command'})}});
    expect(r.showNotification.mock.calls[1][1].body).toBe('Running a command');
    await r.event('push',{data:{json:notice}});
    expect(r.shown).toHaveLength(1);
    expect(r.showNotification.mock.calls.at(-1)).toEqual(['Reply ready',expect.objectContaining({tag:'aside',renotify:true,silent:false})]);
    expect(r.shown[0].data.feed.live).toEqual([]);
  });
  it('live activity: leads with the conversation, never rings while the app is open, and survives reading the thread',async()=>{
    const r=rig(),answer=vi.fn((m,ports)=>ports[0].postMessage({shown:true,viewing:'Synthetic_Thread'}));
    r.matchAll.mockResolvedValue([{url:'https://synthetic-app.test/app',visibilityState:'visible',postMessage:answer}]);
    const live={...notice(),kind:'progress',title:'Aside is working',body:'Browsing the web',phase:'Browsing the web',topic:'Shorts automation',startedAt:5};
    await r.event('push',{data:{json:()=>live}});
    expect(r.showNotification.mock.calls[0]).toEqual(['Shorts automation',expect.objectContaining({body:'Browsing the web',silent:true,renotify:false,icon:'/icons/notification-blank.png'})]);
    // Opening the conversation keeps the running task on the card.
    await r.event('message',{source:{url:'https://synthetic-app.test/app'},data:{type:'aside:notice-seen',sessionId:'Synthetic_Thread'}});
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0].data.feed.live).toHaveLength(1);
    // A finished task while the app is on screen is drawn silently, never rung.
    await r.event('push',{data:{json:()=>({...notice(),topic:'Shorts automation'})}});
    expect(r.showNotification.mock.calls.at(-1)?.[1]).toMatchObject({silent:true,renotify:false});
    // The app then marks it read, which clears the card.
    await r.event('message',{source:{url:'https://synthetic-app.test/app'},data:{type:'aside:notice-seen',sessionId:'Synthetic_Thread'}});
    expect(r.shown).toHaveLength(0);
  });
  it('folds replies from several conversations into one card and keeps other live work on it',async()=>{
    const r=rig(),a={...notice(),topic:'Essay feedback',body:'Tighten the ending.'},b={...notice(),id:'b',sessionId:'Other_Thread',topic:'Trip plan',body:'Booked.'},live={...notice(),id:'c',sessionId:'Third',kind:'progress',title:'Aside is working',body:'Reading pages',phase:'Reading pages',startedAt:1};
    await r.event('push',{data:{json:()=>a}});
    expect(r.showNotification.mock.calls[0][0]).toBe('Essay feedback');
    expect(r.showNotification.mock.calls[0][1].body).toBe('Tighten the ending.');
    await r.event('push',{data:{json:()=>live}});
    expect(r.showNotification.mock.calls[1]).toEqual(['Essay feedback',expect.objectContaining({body:'Tighten the ending.\nStill working · Reading pages',silent:true})]);
    await r.event('push',{data:{json:()=>b}});
    expect(r.shown).toHaveLength(1);
    expect(r.showNotification.mock.calls[2]).toEqual(['2 replies ready',expect.objectContaining({body:'Trip plan · Essay feedback\nStill working · Reading pages',renotify:true,actions:[{action:'open',title:'Open Aside'}]})]);
    // Opening the thread in the app drops just that conversation.
    await r.event('message',{source:{url:'https://synthetic-app.test/app'},data:{type:'aside:notice-seen',sessionId:'Other_Thread'}});
    expect(r.showNotification.mock.calls.at(-1)?.[0]).toBe('Essay feedback');
    // Tapping the card leaves only the still-running task, silently.
    await r.event('notificationclick',{notification:r.shown[0],action:'open'});
    expect(r.showNotification.mock.calls.at(-1)).toEqual(['Aside is working',expect.objectContaining({body:'Reading pages',silent:true})]);
  });
});
