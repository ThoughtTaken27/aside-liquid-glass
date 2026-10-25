import base from './vite.config.ts';
// Preview-only: relax fs allow so shared node_modules fonts resolve.
export default {
  ...(base as any),
  server: { ...((base as any).server ?? {}), port: 5199, strictPort: true, fs: { strict: false } },
};
