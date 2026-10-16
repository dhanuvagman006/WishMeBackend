/**
 * HTTP + WebSocket server. Starts only once the database is reachable and the schema cache is loaded, and drains
 * cleanly on SIGTERM so rolling deploys drop no requests.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { validatePolicies } from './compat/postgrest/compiler.js';
import { loadEnv } from './config/env.js';
import { createDeps } from './deps.js';
import { rootLogger } from './lib/logger.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startServer() {
  const env = loadEnv();
  const log = rootLogger().child({ process: 'api' });
  const deps = await createDeps(env, log);

  for (let attempt = 1; ; attempt++) {
    try {
      await deps.schema.load();
      break;
    } catch (e) {
      if (attempt >= 30) throw e;
      log.warn({ attempt, err: (e as Error).message }, 'database not ready, retrying');
      await sleep(Math.min(1000 * attempt, 5000));
    }
  }
  const problems = validatePolicies(deps.schema, deps.policies);
  if (problems.length) {
    log.error({ problems }, 'policy/schema mismatches: affected tables will answer errors until fixed');
  }
  const stopRefresh = deps.schema.startAutoRefresh();

  const { app, hub } = await buildApp(deps);
  await hub?.start();
  await app.listen({ port: env.PORT, host: env.HOST });
  log.info(
    { port: env.PORT, dbMode: env.DB_MODE, compatDefault: env.COMPAT_DEFAULT_MODE, overrides: env.ROUTE_MODES, functions: deps.functions.names().length },
    'WishMe backend listening',
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down: draining connections');
    const force = setTimeout(() => {
      log.error('forced exit after drain timeout');
      process.exit(1);
    }, 30_000);
    force.unref();
    try {
      stopRefresh();
      await hub?.stop();
      await app.close();
      await deps.close();
    } finally {
      log.info('bye');
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error({ err: e }, 'unhandled rejection'));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((e: unknown) => {
    rootLogger().fatal({ err: e }, 'server failed to start');
    process.exit(1);
  });
}
