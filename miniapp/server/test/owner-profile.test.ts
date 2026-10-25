import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOwnerProfile } from '../src/owner-profile.js';
import { AsideContext } from '../src/asidecontext.js';
import { readPersonalMailConfig, senderTier, studentLine } from '../src/inbox.js';
let root:string;const old=process.env.MINIAPP_OWNER_PROFILE_PATH;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-owner-profile-'));process.env.MINIAPP_OWNER_PROFILE_PATH=path.join(root,'profile.json');fs.mkdirSync(path.join(root,'next'));fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({contextAwareness:{enabled:true}}));fs.writeFileSync(path.join(root,'next/config.json'),JSON.stringify({personalMail:{enabled:true,account:'owner@example.com'}}));});
afterEach(()=>{if(old===undefined)delete process.env.MINIAPP_OWNER_PROFILE_PATH;else process.env.MINIAPP_OWNER_PROFILE_PATH=old;fs.rmSync(root,{recursive:true,force:true});});
const write=(v:unknown)=>fs.writeFileSync(process.env.MINIAPP_OWNER_PROFILE_PATH!,JSON.stringify(v));
describe('private owner profile failure boundary',()=>{
 it('does not send profile facts to background models without explicit opt-in',()=>{write({familyNames:[],privateAppIds:[],displayName:'Synthetic name',schoolLabel:'Synthetic private school',graduationYear:2099});const prompt=studentLine(new Date());expect(prompt).not.toMatch(/Synthetic|2099/);expect(prompt).toContain('has not been shared');write({familyNames:[],privateAppIds:[],schoolLabel:'Synthetic school',graduationYear:2099,shareProfileWithModels:true});expect(studentLine(new Date('2098-10-01'))).toContain('Synthetic school');});
 it.each(['missing','malformed','null','incomplete'])('fails closed for %s profiles',kind=>{if(kind==='malformed')fs.writeFileSync(process.env.MINIAPP_OWNER_PROFILE_PATH!,'{');if(kind==='null')write(null);if(kind==='incomplete')write({displayName:'Synthetic'});expect(readOwnerProfile().privacyConfigured).toBe(false);const ctx=new AsideContext({asideRoot:root,memorySearch:null});expect(ctx.isOff()).toBe(true);expect(ctx.events(0)).toEqual([]);expect(readPersonalMailConfig(root)).toBeNull();expect(senderTier({fromEmail:'staff@school.example',auth:'pass'})).toBe('outside');ctx.close();});
 it('uses explicit domain lists only and still requires authentication',()=>{write({familyNames:['Example'],privateAppIds:['local.example.private'],staffDomains:['school.example'],studentDomains:['students.school.example']});expect(readOwnerProfile().privacyConfigured).toBe(true);expect(senderTier({fromEmail:'staff@school.example',auth:'pass'})).toBe('district');expect(senderTier({fromEmail:'staff@evilschool.example',auth:'pass'})).toBe('outside');expect(senderTier({fromEmail:'staff@school.example',auth:'fail'})).toBe('outside');expect(senderTier({fromEmail:'student@students.school.example',auth:'pass'})).toBe('student');expect(readPersonalMailConfig(root)?.familyNames).toEqual(['Example']);});
 it('re-reads configuration removal instead of retaining a permissive snapshot',()=>{write({familyNames:[],privateAppIds:[]});const ctx=new AsideContext({asideRoot:root,memorySearch:null});expect(ctx.isOff()).toBe(false);fs.unlinkSync(process.env.MINIAPP_OWNER_PROFILE_PATH!);expect(ctx.isOff()).toBe(true);expect(readPersonalMailConfig(root)).toBeNull();ctx.close();});
});
