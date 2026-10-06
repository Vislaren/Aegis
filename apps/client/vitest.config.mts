import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Only framework-free modules in src/core are unit-tested here; screens are covered by
// React Native Testing Library and Playwright once the Expo toolchain is installed. The aliases
// let the core tests run from workspace sources even before the client's own install.
export default defineConfig({
  resolve: {
    alias: {
      '@aegis/contracts': root('../../packages/contracts/src/index.ts'),
      zod: root('../../packages/contracts/node_modules/zod'),
    },
  },
  test: {
    include: ['src/core/**/*.test.ts'],
  },
});
