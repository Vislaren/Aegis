import { defineConfig } from 'vitest/config';

// Services use explicit @Inject() tokens, so tests do not depend on emitted decorator metadata.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
  },
});
