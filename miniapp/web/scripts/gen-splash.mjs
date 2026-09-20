/**
 * Generate the iOS launch screens.
 *
 * iOS will not build a launch image from the manifest the way Android
 * does, so the first frame after tapping the home-screen icon is whatever
 * `apple-touch-startup-image` matches, or plain white if nothing does.
 * That white flash is the single most obvious tell that a home-screen app
 * is a web page.
 *
 * Rendering these in a browser rather than compositing them with an image
 * library keeps them honest: the background is the same `#f9f9f7` the app
 * paints, so the splash and the first painted frame are the same colour
 * and the handover is invisible.
 *
 * Run from `web/`:  node scripts/gen-splash.mjs
 * Then mirror any device changes into APPLE_LAUNCH_SCREENS in
 * `server/src/app.ts`, which emits the matching <link> tags.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// Resolved from this file so the script works in any clone.
const WEB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(WEB, 'public/splash');
fs.mkdirSync(OUT, { recursive: true });
const icon = fs.readFileSync(path.join(WEB, 'public/icons/icon-512.png')).toString('base64');

// Portrait logical sizes and scale factors. The manifest locks the app to
// portrait, so landscape variants would never be shown.
const DEVICES = [
  { w: 440, h: 956, r: 3, name: 'iphone-16-pro-max' },
  { w: 402, h: 874, r: 3, name: 'iphone-16-pro' },
  { w: 430, h: 932, r: 3, name: 'iphone-15-pro-max' },
  { w: 393, h: 852, r: 3, name: 'iphone-15-pro' },
  { w: 428, h: 926, r: 3, name: 'iphone-13-pro-max' },
  { w: 390, h: 844, r: 3, name: 'iphone-13-pro' },
  { w: 375, h: 812, r: 3, name: 'iphone-x' },
  { w: 414, h: 896, r: 3, name: 'iphone-xs-max' },
  { w: 414, h: 896, r: 2, name: 'iphone-xr' },
  { w: 375, h: 667, r: 2, name: 'iphone-se' },
  { w: 414, h: 736, r: 3, name: 'iphone-8-plus' },
  { w: 320, h: 568, r: 2, name: 'iphone-se1' },
];

const html = (w, h) => `<!doctype html><meta charset=utf-8>
<style>
  html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden}
  body{background:#f9f9f7;display:flex;align-items:center;justify-content:center}
  /* Icon sized as a fraction of the short edge so it reads the same on
     every device rather than shrinking on the large ones. */
  img{width:${Math.round(Math.min(w, h) * 0.26)}px;height:auto;border-radius:22%}
</style>
<img src="data:image/png;base64,${icon}">`;

const b = await chromium.launch();
let total = 0;
for (const d of DEVICES) {
  const p = await b.newPage({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: d.r });
  await p.setContent(html(d.w, d.h));
  await p.waitForTimeout(120);
  const file = path.join(OUT, `${d.name}.png`);
  await p.screenshot({ path: file });
  await p.close();
  const kb = fs.statSync(file).size / 1024;
  total += kb;
  console.log(`  ${d.name.padEnd(20)} ${d.w}x${d.h}@${d.r}x -> ${(d.w*d.r)}x${(d.h*d.r)}  ${kb.toFixed(1)} KB`);
}
await b.close();
console.log(`  TOTAL ${total.toFixed(0)} KB across ${DEVICES.length} screens`);

// Emit the link tags for the server to inject.
const links = DEVICES.map(d =>
  `'  <link rel="apple-touch-startup-image" media="(device-width: ${d.w}px) and (device-height: ${d.h}px) and (-webkit-device-pixel-ratio: ${d.r}) and (orientation: portrait)" href="/splash/${d.name}.png" />',`
).join('\n');
fs.writeFileSync('/tmp/iostest/splash-links.txt', links);
console.log('  link tags written');
