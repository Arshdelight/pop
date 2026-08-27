import { defineConfig } from 'vitest/config';

// Integration tests spawn the real CLI as a subprocess (tsx loader startup is
// ~1s on Windows, and one test may chain several commands), so give each test
// a generous timeout instead of tuning per-case.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
