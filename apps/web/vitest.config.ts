import { defineConfig } from 'vitest/config';

const sharedSource = new URL(
  '../../packages/shared/src/index.ts',
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export default defineConfig({
  resolve: {
    alias: {
      '@logbook/shared': sharedSource,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // Heavy form screens (structured switching events) exceed the 5 s default
    // on shared CI/desktop machines.
    testTimeout: 20_000,
    // CSS is processed so contract tests can read styles.css?raw (admin header
    // contrast regression, t14). Component tests do not import the stylesheet.
    css: true,
  },
});
