// vitest/config re-exports vite's defineConfig with the `test` block typed.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Stamp the service worker's cache version with the identity of this build.
 *
 * `sw.js` used to carry a hand-written version string and a comment asking
 * the next person to remember to bump it. Forgetting costs more than it
 * sounds: the shell cache outlives the assets it points at, because a build
 * empties `dist` and emits new content hashes, so the cached shell asks for
 * an `/assets/index-<hash>.css` that is no longer on the server. The asset
 * handler misses, the fetch 404s, and the app paints with no stylesheet.
 * Both caches are behaving as designed, so nothing recovers on its own and
 * the phone stays broken until someone reinstalls it. Reproduced, then
 * fixed here.
 *
 * The id is a hash of the emitted asset filenames, which are themselves
 * content hashes. So it changes when and only when the bundle changes, and
 * a rebuild that produces identical output leaves everyone's cache alone.
 */
function swBuildId(): Plugin {
  const names: string[] = [];
  return {
    name: 'sw-build-id',
    apply: 'build',
    generateBundle(_options, bundle) {
      names.push(...Object.keys(bundle).sort());
    },
    closeBundle() {
      const swPath = path.resolve(__dirname, 'dist/sw.js');
      if (!fs.existsSync(swPath)) return;
      const id = createHash('sha256')
        .update(names.join('\n'))
        .digest('hex')
        .slice(0, 12);
      const src = fs.readFileSync(swPath, 'utf8');
      if (!src.includes('__BUILD_ID__')) {
        // Loud, because a silent miss here reintroduces the exact bug this
        // exists to prevent, and it would only show up on someone's phone.
        this.error('sw.js has no __BUILD_ID__ placeholder to stamp');
      }
      fs.writeFileSync(swPath, src.replaceAll('__BUILD_ID__', id));
    },
  };
}

/**
 * Emit `.br` and `.gz` next to every compressible build artefact.
 *
 * The server was shipping the bundle raw. Measured against the live
 * service on 2026-09-01: `/assets/index-<hash>.js` came back as 512KB with
 * `content-encoding: none`, and the whole emitted JS+CSS set is 1.99MB.
 * The same bytes gzip to 522KB and brotli to less again. On a phone
 * reaching the Mac over a tailnet, that difference IS the "everything
 * loads very slow" complaint -- it is several seconds of transfer on the
 * first launch of every new build, before a single byte can be parsed.
 *
 * Compressing at build time rather than per request is the right trade
 * here: these files are content-hashed and immutable, so the work is done
 * once instead of on every cold cache, and the server can hand the
 * precompressed file straight to the socket. `@fastify/static`'s
 * `preCompressed` option is what picks them up.
 */
function precompressAssets(): Plugin {
  /** Below this, framing overhead eats the saving. */
  const MIN_BYTES = 1024;
  const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|webmanifest|map)$/i;
  return {
    name: 'precompress-assets',
    apply: 'build',
    // After `closeBundle` so the service worker has already been stamped;
    // compressing it before that would ship a `.br` of the unstamped file.
    enforce: 'post',
    closeBundle: {
      order: 'post',
      handler() {
        const dist = path.resolve(__dirname, 'dist');
        if (!fs.existsSync(dist)) return;
        const walk = (dir: string): string[] =>
          fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return walk(full);
            return COMPRESSIBLE.test(entry.name) ? [full] : [];
          });
        for (const file of walk(dist)) {
          const raw = fs.readFileSync(file);
          if (raw.byteLength < MIN_BYTES) continue;
          const br = zlib.brotliCompressSync(raw, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
            },
          });
          if (br.byteLength < raw.byteLength) fs.writeFileSync(`${file}.br`, br);
          // gzip as well: brotli needs HTTPS in some older mobile browsers,
          // and the tunnel is not always TLS.
          const gz = zlib.gzipSync(raw, { level: 9 });
          if (gz.byteLength < raw.byteLength) fs.writeFileSync(`${file}.gz`, gz);
        }
      },
    },
  };
}

const API_TARGET = process.env.MINIAPP_DEV_API || 'http://127.0.0.1:8790';

export default defineConfig({
  plugins: [react(), swBuildId(), precompressAssets()],
  test: {
    // Component tests drive real DOM events through React; the pure-logic
    // suites do not care either way.
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // The mini app is served from one origin; assets are relative so the
    // same bundle works behind a tunnel subpath.
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        /**
         * Split the libraries out of the app chunk, for the cache rather
         * than for the download.
         *
         * Everything used to land in one `index-<hash>.js`. That file is
         * content-hashed and served `immutable`, so it is perfect on a
         * repeat launch and worthless the moment anything changes: edit
         * one line of CSS-in-a-component and the hash moves, and the phone
         * re-downloads React, react-markdown and the whole micromark chain
         * along with it. On a phone reaching the Mac over a tailnet that
         * is the entire cost of every deploy, and this app gets deployed a
         * lot.
         *
         * React and the markdown pipeline change when a dependency is
         * upgraded, which is roughly never. Giving them their own hashes
         * means an ordinary app change invalidates only the app.
         *
         * Two buckets, not twenty: each chunk is a separate request, and
         * past a handful the round trips cost more than the cache hits
         * save.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/](thinking-orbs|liquid-gooey)[\\/]/.test(id)) {
            return 'motion';
          }
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'react';
          }
          if (
            /[\\/]node_modules[\\/](react-markdown|remark-.*|micromark.*|mdast-.*|hast-.*|unist-.*|unified|vfile.*|bail|trough|devlop|decode-named-character-reference|character-entities.*|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|html-void-elements|trim-lines|zwitch|longest-streak|ccount|escape-string-regexp|markdown-table|is-plain-obj|estree-.*|style-to-.*)[\\/]/.test(
              id,
            )
          ) {
            return 'markdown';
          }
        },
      },
    },
  },
  server: {
    // bind v4 explicitly: the default resolves to ::1 on this Mac, which
    // makes http://127.0.0.1:5273 refuse connections
    host: '127.0.0.1',
    port: 5273,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
});
