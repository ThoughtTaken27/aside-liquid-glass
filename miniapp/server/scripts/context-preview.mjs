// Synthetic-only fixture server. No live app, source, account or model imports.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const WORK=fileURLToPath(new URL('../../',import.meta.url));
const TMP=os.tmpdir();
const require=createRequire(WORK+'/package.json');
const Fastify=require('fastify');
const {NextStore}=await import(WORK+'/server/dist/next.js');
const {contextRoutes}=await import(WORK+'/server/dist/context-routes.js');
const root=fs.mkdtempSync(path.join(TMP,'context-synthetic-preview-'));fs.chmodSync(root,0o700);
const app=Fastify({logger:false,bodyLimit:16384});const fixtures=new Map();
const ids=['schoology:123456789','schoology:987654321','schoology:765432109'];
function sourceRows(base=Date.now()) {return ids.map((id,i)=>({id,source:'schoology',title:['Lab report outline','Design presentation','Reading reflection'][i],context:['Science','Studio','Literature'][i],dueISO:new Date(base+(i===2?4:2)*86400000).toISOString(),estMinutes:[25,20,15][i],lane:'you',confidence:.95,url:`https://school.schoology.com/assignment/${id.split(':')[1]}`,steps:['Read the instructions','Plan your own response','Review before submitting'],kind:'coursework',resolved:false,seenAt:new Date(base-3600000).toISOString()}));}
function trails(base=Date.now()) {return [{key:ids[0],kind:'Schoology',title:'Lab report outline',url:'https://school.schoology.com/assignment/123456789',lastAt:base-8*60000,minutes:18},{key:ids[1],kind:'Schoology',title:'Design presentation',url:'https://school.schoology.com/assignment/987654321',lastAt:base-45*60000,minutes:9},{key:'gdoc:SYNTHETIC_DOC_123456789',kind:'Doc',title:'Synthetic page title, not a saved memory',url:'https://docs.google.com/document/d/SYNTHETIC_DOC_123456789/edit',lastAt:base-8*60000,minutes:14}];}
function feed(f,at){fs.writeFileSync(path.join(f.dir,'next','feeds','schoology.json'),JSON.stringify({source:'schoology',version:1,updatedAt:new Date(at).toISOString(),items:f.rows}),{mode:0o600});}
async function create(scenario){if(fixtures.size>=20)throw new Error('Fixture limit reached');const id=crypto.randomUUID(),dir=path.join(root,id);fs.mkdirSync(path.join(dir,'next','feeds'),{recursive:true,mode:0o700});const f={id,dir,scenario,rows:sourceRows(),trail:trails(),paused:false};feed(f,Date.now()-25*60000);f.store=new NextStore({asideRoot:dir,stateDir:dir});if(scenario!=='off'){const old=scenario==='stale'?Date.now()-3*86400000:Date.now();f.store.contextMemory.configure({expectedRevision:0,acknowledgement:'local-structured-context-v1',preferences:{enabled:true,sources:['schoology','work-trail'],pausedUntil:scenario==='paused'?new Date(Date.now()+3600000).toISOString():null,retentionDays:14,excludedHosts:[]}},new Date(old));if(scenario!=='empty'&&scenario!=='paused'){for(const delta of [86400000,2*3600000,0]){const at=old-delta;f.rows=sourceRows(at);f.trail=trails(at);feed(f,at-20*60000);f.store.plan(new Date(at),f.trail);}}if(scenario==='empty'){f.rows=[];feed(f,Date.now());}if(scenario==='error')fs.writeFileSync(path.join(dir,'next','context-memory','key'),Buffer.from('invalid synthetic key'),{mode:0o600});}fixtures.set(id,f);return f;}
app.post('/__context-fixture',async(req,reply)=>{try{const scenario=req.body?.scenario; if(!['off','ready','empty','stale','paused','error'].includes(scenario))return reply.code(400).send({error:'invalid scenario'});return{id:(await create(scenario)).id};}catch(e){console.error('Synthetic fixture bootstrap failed:',e.name,e.message);return reply.code(503).send({error:'synthetic fixtures unavailable'});}});
const instance=req=>{const id=(req.headers.authorization||'').replace(/^Bearer synthetic-preview:/,'');return fixtures.get(id);};
const gate=async(req,reply)=>{if(!instance(req))return reply.code(401).send({error:'fixture_only'});};
// Register the real routes for every test instance via request-selected forwarding.
const internal=new Map();
async function routes(f){if(internal.has(f.id))return internal.get(f.id);const child=Fastify({logger:false});await child.register(async plugin=>{await contextRoutes(plugin,{memory:f.store.contextMemory,globalPaused:()=>f.paused,resolveTask:id=>f.store.rawFor(id),requireAuth:async()=>{},refresh:async()=>{const now=Date.now();feed(f,now);f.store.plan(new Date(now),f.trail);}});},{prefix:'/api/next/context'});await child.ready();internal.set(f.id,child);return child;}
app.all('/api/next/context*',{preHandler:gate},async(req,reply)=>{const child=await routes(instance(req));const res=await child.inject({method:req.method,url:req.url,payload:req.body});for(const[k,v]of Object.entries(res.headers))if(!['content-length','connection','date'].includes(k))reply.header(k,v);return reply.code(res.statusCode).send(res.rawPayload);});
app.get('/api/next',{preHandler:gate},async req=>{const f=instance(req);return{...f.store.plan(new Date(),f.scenario==='empty'?[]:f.trail),control:{paused:f.paused,pausedAt:null,reason:null}};});
app.get('/api/next/safety',{preHandler:gate},async req=>{const f=instance(req);return{control:{paused:f.paused,pausedAt:null,reason:null},running:[],parts:[],ledger:{ok:true,count:0,checkedAt:new Date().toISOString(),brokenAt:null}};});
app.get('/api/next/activity',{preHandler:gate},async()=>({entries:[],more:false}));
app.get('/api/next/projects',{preHandler:gate},async()=>({projects:[],seeds:[]}));
app.get('/api/next/helpers',{preHandler:gate},async()=>({helpers:[]}));
app.get('/api/next/research',{preHandler:gate},async()=>({cards:[]}));
app.get('/api/next/inbox',{preHandler:gate},async()=>({rows:[],enabled:false,personalEnabled:false}));
app.post('/api/next/pause',{preHandler:gate},async req=>{const f=instance(req);f.paused=req.body?.paused===true;return{control:{paused:f.paused,pausedAt:null,reason:null},stopped:[],stopErrors:[]};});
app.post('/api/next/refresh',{preHandler:gate},async()=>({ok:true}));
app.post('/api/next/start',{preHandler:gate},async(_req,reply)=>reply.code(403).send({error:'helpers_disabled'}));
const buildHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(WORK,'server/dist/context-memory.js'))).digest('hex');
app.get('/api/health',async()=>({ok:true,synthetic:true,contextBuild:buildHash}));
app.setNotFoundHandler((_req,reply)=>reply.code(404).send({error:'unsupported synthetic preview route'}));
await app.listen({host:'127.0.0.1',port:5342});
console.log('Synthetic-only context API listening at http://127.0.0.1:5342. No live fallback.');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await app.close();for(const c of internal.values())await c.close();process.exit(0);});
