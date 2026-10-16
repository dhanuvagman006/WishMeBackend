/**
 * Worker process: runs BullMQ processors and schedules repeatable jobs. Safe to run several replicas; BullMQ hands each
 * job to one worker, and repeatable jobs are keyed so they are scheduled once.
 */
import { Worker, Queue, type Job } from 'bullmq';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config/env.js';
import { createDeps } from './deps.js';
import { createRedis } from './lib/redis.js';
import { rootLogger } from './lib/logger.js';
import { modules } from './jobs/processors/index.js';
import type { ProcessorDef } from './jobs/worker-types.js';

export async function startWorker() {
  const env = loadEnv();
  const log = rootLogger().child({ process: 'worker' });
  if (!env.REDIS_URL) throw new Error('The worker needs REDIS_URL');
  const deps = await createDeps(env, log);
  await deps.schema.load();

  const byQueue = new Map<string, ProcessorDef[]>();
  for (const m of modules) for (const p of m.processors) byQueue.set(p.queue, [...(byQueue.get(p.queue) ?? []), p]);

  const workers: Worker[] = [];
  for (const [queue, procs] of byQueue) {
    const concurrency = Math.max(...procs.map((p) => p.concurrency ?? 5));
    const connection = createRedis(env, 'bullmq')!;
    const w = new Worker(
      queue,
      async (job: Job) => {
        const p = procs.find((x) => x.name === job.name);
        if (!p) throw new Error(`No processor for ${queue}/${job.name}`);
        const started = Date.now();
        const result = await p.handle(job, deps);
        log.info({ queue, job: job.name, id: job.id, ms: Date.now() - started }, 'job done');
        return result;
      },
      { connection, prefix: `${env.REDIS_PREFIX}:bull`, concurrency },
    );
    w.on('failed', (job, err) => log.error({ queue, job: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
    workers.push(w);
  }

  // Repeatable jobs: upserted by scheduler id, so restarts and multiple replicas do not duplicate them.
  const schedConn = createRedis(env, 'bullmq')!;
  for (const m of modules) {
    for (const r of m.repeatables) {
      const q = new Queue(r.queue, { connection: schedConn, prefix: `${env.REDIS_PREFIX}:bull` });
      await q.upsertJobScheduler(`${r.queue}:${r.name}`, { pattern: r.cron, tz: 'UTC' }, { name: r.name, data: r.data ?? {} });
      await q.close();
    }
  }
  log.info({ queues: [...byQueue.keys()] }, 'worker started');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'worker shutting down');
    await Promise.all(workers.map((w) => w.close()));
    schedConn.disconnect();
    await deps.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startWorker().catch((e: unknown) => {
    rootLogger().fatal({ err: e }, 'worker failed to start');
    process.exit(1);
  });
}
