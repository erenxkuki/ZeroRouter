import { defineConfig } from 'vitest/config';

/**
 * Test scope: sources only.
 *
 * The server `build` compiles src → dist (including test files, a repo
 * convention); without this include, vitest would collect the compiled copies
 * in dist too — doubling every suite and its scrypt-heavy boot load.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
