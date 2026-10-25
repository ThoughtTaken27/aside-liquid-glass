import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** Isolated synthetic preview. Never proxies the live mobile service. */
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', port: 5341, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:5342', changeOrigin: true }, '/__context-fixture': { target: 'http://127.0.0.1:5342', changeOrigin: true } }, fs: { allow: ['..', realpathSync(fileURLToPath(new URL('../node_modules', import.meta.url)))] } } });
