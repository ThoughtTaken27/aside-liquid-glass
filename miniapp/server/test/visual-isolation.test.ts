import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { mintToken } from '../src/auth.js';
import { prepareVisual, visualLibrary } from '../src/visual-render.js';
import { FRAME_SCRIPT } from '../src/visual-runtime.js';
import { supportsVisualNetworkIsolation, VISUAL_CONNECTION_ALLOWLIST, VISUAL_STATIC_CSP } from '../src/visuals.js';

const chrome = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/155.0.0.0 Mobile Safari/537.36';
describe('network isolation compatibility', () => {
  it.each([chrome, 'Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36', 'Mozilla/5.0 Chromium/154.0.0.0', 'Mozilla/5.0 HeadlessChrome/155.0.0.0'])('allows a supported Chromium engine: %s', ua => expect(supportsVisualNetworkIsolation(ua)).toBe(true));
  it.each([undefined, '', 'Mozilla/5.0 Chrome/151.0.0.0', 'Mozilla/5.0 HeadlessChrome/151.0.0.0', 'Mozilla/5.0 Firefox/155.0', 'Mozilla/5.0 (iPhone) CriOS/155.0.0.0 Safari/605', 'Mozilla/5.0 Safari/605.1.15'])('fails closed for an unsupported or absent engine: %s', ua => expect(supportsVisualNetworkIsolation(ua)).toBe(false));
  it('uses an explicitly empty network allowlist, including redirects and WebRTC', () => expect(VISUAL_CONNECTION_ALLOWLIST).toBe('(); redirects=block; webrtc=block'));
});
describe('offline card compilation', () => {
  const source = (name: string) => `globalThis.libraryName=${JSON.stringify(name)};`;
  it('embeds locked chart code without a runtime CDN request', () => {
    const html = prepareVisual('<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js" integrity="synthetic"></script><button onclick="this.textContent=2">1</button>', true, source);
    expect(html).toContain('libraryName="chart"'); expect(html).not.toContain('cdn.jsdelivr.net'); expect(html).not.toContain('integrity='); expect(html).toContain('onclick="this.textContent=2"');
  });
  it('keeps Three.js and OrbitControls imports offline', () => {
    const html = prepareVisual('<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script><script type="module">import {OrbitControls} from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js";</script>', true, source);
    expect(html).not.toContain('https://cdn.jsdelivr.net'); expect(html).toContain('data:text/javascript;base64,'); expect(html).toContain('import {OrbitControls}');
  });
  it('never fetches or rewrites unrecognized/malicious libraries', () => {
    for (const url of ['https://cdn.jsdelivr.net.evil.test/npm/d3@7', 'https://cdn.jsdelivr.net/npm/d3@7?leak=synthetic', 'https://user@cdn.jsdelivr.net/npm/d3@7', 'http://cdn.jsdelivr.net/npm/d3@7', 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js']) expect(visualLibrary(url)).toBeNull();
    expect(prepareVisual('<script src="https://unknown.example/library.js"></script>', true, source)).toContain('https://unknown.example/library.js');
  });
  it('retains the resize/theme bridge and contains no arbitrary message-command bridge', () => {
    const html = prepareVisual('<p>Synthetic card</p>', true, source); expect(html).toContain(FRAME_SCRIPT); expect(FRAME_SCRIPT).toContain('e.source!==parent'); expect(FRAME_SCRIPT).not.toMatch(/fetch\(|eval\(|window\.open/);
  });
  it('limits old engines to the exact trusted bridge and strips fallback navigation', () => {
    const html = prepareVisual('<meta http-equiv="refresh" content="0;url=https://outside.example/"><a href="https://outside.example/" ping="https://outside.example/ping">Click</a><script>globalThis.untrusted=true</script><p>Still readable</p>', false, source);
    expect(html).not.toContain('http-equiv="refresh"'); expect(html).not.toContain('href="https://outside.example/"'); expect(html).toContain('Still readable'); expect(html).toContain('Update to Chrome 152'); expect(html).toContain(FRAME_SCRIPT); expect(VISUAL_STATIC_CSP).toMatch(/script-src 'sha256-[^']+'/); expect(VISUAL_STATIC_CSP).not.toContain('unsafe-inline\' data:');
  });
});
let app: FastifyInstance | undefined, dir: string | undefined;
const saved = { ...process.env };
afterEach(async () => { await app?.close(); app=undefined; process.env={...saved}; if(dir)fs.rmSync(dir,{recursive:true,force:true});dir=undefined; });
it('actual API issues versioned URLs and applies firewall/no-store to both current and legacy routes', async () => {
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-visual-api-'));
  process.env.MINIAPP_CONFIG=path.join(dir,'no-config.json');process.env.MINIAPP_STATE_DIR=path.join(dir,'state');process.env.MINIAPP_SESSIONS_DIR=path.join(dir,'sessions');fs.mkdirSync(process.env.MINIAPP_SESSIONS_DIR);
  const config=loadConfig(),secret='synthetic-visual-api-secret-not-real';({app}=await buildServer(config,{jwtSecret:secret}));await app.ready();
  const authorization='Bearer '+mintToken(secret,{uid:config.allowedUserId,sub:String(config.allowedUserId)});
  const put=await app.inject({method:'POST',url:'/api/visuals',headers:{authorization},payload:{html:'<p>Synthetic card</p><script>window.synthetic=true</script>'}});expect(put.statusCode).toBe(200);expect(put.json().url).toMatch(/^\/api\/visuals\/v2\/[a-f0-9]{48}$/);
  for(const url of [put.json().url,'/api/visuals/'+put.json().id]){const get=await app.inject({url,headers:{'user-agent':chrome}});expect(get.statusCode).toBe(200);expect(get.headers['connection-allowlist']).toBe(VISUAL_CONNECTION_ALLOWLIST);expect(get.headers['cache-control']).toBe('no-store');expect(get.headers['x-dns-prefetch-control']).toBe('off');expect(get.headers['content-security-policy']).toContain("script-src 'unsafe-inline' data:");}
  const old=await app.inject({url:put.json().url,headers:{'user-agent':'Firefox/155.0'}});expect(old.statusCode).toBe(200);expect(old.headers['content-security-policy']).toContain("script-src 'sha256-");expect(old.body).toContain('Update to Chrome 152');
  const shell=await app.inject({url:'/api/health'});expect(shell.headers['content-security-policy']).toContain("frame-src 'self'");
});
