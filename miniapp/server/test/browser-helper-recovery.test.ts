import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openMcpRepl, SharedRepl, frameScript, type ReplLike } from '../src/liveview.js';
const dirs: string[] = [];
const helpers: Array<{close(): void}> = [];
afterEach(() => { helpers.splice(0).forEach(h => h.close()); dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); });
function fakeCli() {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-mcp-')); dirs.push(dir); const file = path.join(dir,'fake.mjs');
 fs.writeFileSync(file, `#!${process.execPath}\nimport readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize'){console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{capabilities:{}}}));return;}
const code=m.params?.arguments?.code||'';if(code==='stall')return;
const text=code.includes('sessions.current')?'@@LV"synthetic-helper"':'@@LV"recovered"';
console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text}]}}));});\n`,{mode:0o700}); return file;
}
describe('persistent browser helper recovery', () => {
 it('retires a timed-out evaluator rather than claiming it is still warm', async () => {
  const repl = await openMcpRepl(fakeCli()); helpers.push(repl);
  await expect(repl.run('stall',30)).rejects.toThrow('timed out'); expect(repl.alive).toBe(false);
  await expect(repl.run('next',100)).rejects.toThrow('not running');
 });
 it('the next shared read starts a clean process after a stall', async () => {
  const cli = fakeCli(); let starts=0;
  const shared = new SharedRepl(signal=>{starts++;return openMcpRepl(cli,signal);}); helpers.push(shared);
  await expect(shared.run('stall',30)).rejects.toThrow('timed out'); expect(shared.warm).toBe(false);
  expect(await shared.run('next',500)).toContain('recovered'); expect(starts).toBe(2);
 });
 it('closing during startup cannot resurrect the old helper', async () => {
  let release!: (r:ReplLike)=>void; let closed=false;
  const shared = new SharedRepl(()=>new Promise(r=>{release=r;})); helpers.push(shared);
  const loading=shared.run('next').catch(e=>e); shared.close();
  release({alive:true,run:async()=>'',close(){closed=true;}});
  expect((await loading).message).toContain('closed during start'); expect(closed).toBe(true); expect(shared.warm).toBe(false);
 });
 it('a stale screenshot handle is evicted before the next attachment attempt', () => {
  expect(frameScript('TARGET',50)).toContain('delete lv["TARGET"]');
 });
});
