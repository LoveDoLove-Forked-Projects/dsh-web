import { defineConfig } from 'vitest/config'

export default defineConfig({
  // npm SDK packages reference sourcemaps that are not published (files
  // exclude *.map); do not attempt to load them during transform.
  server: {
    sourcemapIgnoreList: () => true,
  },
  test: {
    include: ['tests/**/*.{spec,test}.{ts,tsx}'],
    pool: 'forks',
    environment: 'node',
    testTimeout: 20_000,
    server: {
      deps: {
        // @deepseek-ai SDK packages ship browser bundles (CSS imports included);
        // keep them vite-transformed instead of node-externalized. The task
        // board's own sources arrive through a relative import from the test
        // harness and transform the same way.
        inline: [/@deepseek-ai\//, /dsh-task-board\/src\//],
      },
    },
  },
})
