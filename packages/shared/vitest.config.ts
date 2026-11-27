import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tsc` emits compiled tests into dist; they must not be picked up as a
    // second, stale test suite after a parallel build.
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
