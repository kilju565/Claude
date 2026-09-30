import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // examples/ contains a deliberately failing node:test suite — never collect it.
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
