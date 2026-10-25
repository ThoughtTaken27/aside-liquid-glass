import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { MINIAPP_OWNER_PROFILE_PATH: fileURLToPath(new URL('./test/fixtures/synthetic-owner-profile.json', import.meta.url)) },
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
