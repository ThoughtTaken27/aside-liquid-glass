import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enablePhoneNotifications, readNotificationDevice } from '../src/phoneNotifications';
vi.mock('../src/api',()=>({currentAuthToken:()=> 'synthetic-test-token'}));
let stored:string|null,fetchMock:ReturnType<typeof vi.fn>,requestPermission:ReturnType<typeof vi.fn>,unsubscribe:ReturnType<typeof vi.fn>,subscribe:ReturnType<typeof vi.fn>;
const previous={id:'old',preferences:{previews:true,progress:false}};
beforeEach(()=>{
  stored=null;unsubscribe=vi.fn(async()=>true);const sub={unsubscribe,toJSON:()=>({endpoint:'https://fcm.googleapis.com/synthetic'})};subscribe=vi.fn(async()=>sub);requestPermission=vi.fn(async()=> 'granted');
  const reg={pushManager:{getSubscription:async()=>sub,subscribe}};
  vi.stubGlobal('localStorage',{getItem:()=>stored,setItem:(_key:string,value:string)=>{stored=value;},removeItem:()=>{stored=null;}});
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('PushManager',class{});vi.stubGlobal('Notification',{permission:'default',requestPermission});
  Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{register:vi.fn(async()=>reg),ready:Promise.resolve(reg),getRegistration:async()=>reg}});
  fetchMock=vi.fn(async(url)=>new Response(JSON.stringify(String(url).endsWith('/config')?{publicKey:btoa('x'.repeat(65))}:String(url).includes('/devices/')?previous:{id:'new',preferences:{previews:false,progress:false}}),{status:200}));vi.stubGlobal('fetch',fetchMock);
});
afterEach(()=>{vi.unstubAllGlobals();});
describe('real browser-side notification utilities',()=>{
  it('requests permission before any network, and does nothing after refusal',async()=>{requestPermission.mockImplementationOnce(async()=>{expect(fetchMock).not.toHaveBeenCalled();return'denied';});await expect(enablePhoneNotifications()).rejects.toThrow('blocking');expect(fetchMock).not.toHaveBeenCalled();expect(unsubscribe).not.toHaveBeenCalled();});
  it('treats a deleted or expired device as disconnected rather than requiring an app restart',async()=>{stored='old';fetchMock.mockResolvedValueOnce(new Response('{}',{status:404}));expect(await readNotificationDevice()).toBeNull();expect(unsubscribe).not.toHaveBeenCalled();});
  it('rotates an orphan endpoint on an explicit enable tap with private defaults',async()=>{stored='old';fetchMock.mockImplementation(async(url)=>new Response(JSON.stringify(String(url).endsWith('/config')?{publicKey:btoa('x'.repeat(65))}:String(url).includes('/devices/')?{}:{id:'new',preferences:{previews:false,progress:false}}),{status:String(url).includes('/devices/')?404:200}));expect((await enablePhoneNotifications()).id).toBe('new');expect(unsubscribe).toHaveBeenCalledTimes(1);expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({userVisibleOnly:true}));const registration=fetchMock.mock.calls.find(c=>String(c[0]).endsWith('/subscribe'))!;expect(JSON.parse(registration[1].body)).not.toHaveProperty('preferences');expect(stored).toBe('new');});
  it('keeps a registered endpoint and its explicitly chosen preferences',async()=>{stored='old';await enablePhoneNotifications();expect(unsubscribe).not.toHaveBeenCalled();expect(subscribe).not.toHaveBeenCalled();const registration=fetchMock.mock.calls.find(c=>String(c[0]).endsWith('/subscribe'))!;expect(JSON.parse(registration[1].body).preferences).toEqual(previous.preferences);});
});
