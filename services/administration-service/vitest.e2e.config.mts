import { defineConfig } from 'vitest/config';

// Composed cross-service journey (test-only composition of identity, administration, audit, gateway).
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
