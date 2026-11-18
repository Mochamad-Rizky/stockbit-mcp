import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/cli.ts'],
      reporter: ['text', 'lcov', 'json-summary'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          // Live calls against Stockbit with the session saved by `stockbit-mcp login`. They only
          // read, and skip when there is no session.
          include: ['test/e2e/**/*.e2e.test.ts'],
          testTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
