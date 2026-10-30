import { defineConfig } from 'vitest/config'

// The suite runs against the real Node service: a real HTTP server on an
// ephemeral loopback port, a real SQLite file on disk, and real WebSocket
// clients. Nothing here substitutes an in-memory fake for the runtime.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
