import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-env.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // light-my-request (app.inject) requires an ESM-only dependency; Node < 22.12 needs this flag to load it.
    // Production runs Node 24, which supports require(esm) natively.
    poolOptions: Number(process.versions.node.split('.')[0]) < 22 ? { forks: { execArgv: ['--experimental-require-module'] } } : {},
    // Integration tests share one Postgres and one Redis; run files one at a time to keep them independent.
    fileParallelism: false,
  },
});
