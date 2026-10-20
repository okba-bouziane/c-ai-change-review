import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

// Runs only the real-Claude end-to-end test: `npm run test:e2e`.
export default defineConfig({
  test: {
    ...base.test,
    include: ['src/test/e2e/**/*.e2e.test.ts'],
    testTimeout: 240000,
  },
});
