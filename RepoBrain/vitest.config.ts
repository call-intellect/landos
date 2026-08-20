import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Our own unit/integration tests only. examples/* are indexing fixtures, not our CI.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'examples/**'],
  },
});
