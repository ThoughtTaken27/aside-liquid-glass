/** Build pinned local copies. No card ever fetches a CDN at runtime. */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
const outdir = path.resolve(import.meta.dirname, '../dist/visual-vendor');
await fs.mkdir(outdir, { recursive: true });
const jobs = [
  { name: 'chart', entry: 'chart.js/auto', format: 'iife', globalName: '__AsideChart', footer: { js: 'globalThis.Chart=__AsideChart.default;' } },
  { name: 'd3', entry: 'd3', format: 'iife', globalName: 'd3' },
  { name: 'three', entry: 'three', format: 'esm' },
  { name: 'three-global', entry: 'three', format: 'iife', globalName: 'THREE' },
  { name: 'orbit-controls', entry: 'three/addons/controls/OrbitControls.js', format: 'esm', external: ['three'] },
];
for (const { name, entry, ...options } of jobs) {
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: path.join(outdir, name + '.js'), bundle: true, minify: true,
    platform: 'browser', target: 'es2022', legalComments: 'eof', ...options });
}
for (const pkg of ['three', 'chart.js', 'd3']) {
  let dir = path.dirname(require.resolve(pkg));
  while (path.basename(dir) !== pkg && dir !== path.dirname(dir)) dir = path.dirname(dir);
  for (const name of ['LICENSE', 'LICENSE.md']) {
    try { await fs.copyFile(path.join(dir, name), path.join(outdir, pkg.replace('.', '-') + '-LICENSE')); break; } catch {}
  }
}
console.log('Built offline visual libraries: Chart.js, D3, Three.js, OrbitControls');
