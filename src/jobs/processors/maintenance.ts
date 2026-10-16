/** Housekeeping: expired tokens and codes, old idempotency keys, and the transactional outbox. */
import { sweepStaleMusic } from '../../domains/audio/music.js';
import { sweepStaleFlightBookings } from '../../domains/travel/flights.js';
import { QUEUES } from '../queues.js';
import type { ProcessorModule } from '../worker-types.js';

export const module: ProcessorModule = {
  processors: [
    {
      queue: QUEUES.maintenance,
      name: 'purge-expired',
      concurrency: 1,
      handle: async (_job, deps) => {
        const tokens = await deps.refresh.purgeExpired();
        const otps = await deps.otps.purgeOld();
        const keys = await deps.db`delete from wishme.idempotency_keys where expires_at < now() returning 1`;
        const resets = await deps.db`delete from wishme.password_resets where expires_at < now() - interval '1 day' returning 1`;
        return { tokens, otps, idempotencyKeys: keys.length, resets: resets.length };
      },
    },
    {
      queue: QUEUES.maintenance,
      name: 'drain-outbox',
      concurrency: 1,
      handle: async (_job, deps) => {
        // Claims a batch, publishes each row as a job (deterministic id = outbox id), marks it processed.
        const rows = await deps.db<{ id: string; topic: string; payload: Record<string, unknown> }[]>`
          update wishme.outbox set attempts = attempts + 1
          where id in (
            select id from wishme.outbox
            where processed_at is null and available_at <= now() and attempts < 10
            order by id limit 200 for update skip locked)
          returning id::text, topic, payload`;
        for (const r of rows) {
          const [queue, name] = r.topic.split(':') as [string, string];
          try {
            await deps.jobs.enqueue(queue as never, name ?? 'default', r.payload, { jobId: `outbox:${r.id}` });
            await deps.db`update wishme.outbox set processed_at = now() where id = ${r.id}`;
          } catch (e) {
            await deps.db`
              update wishme.outbox set last_error = ${(e as Error).message.slice(0, 500)},
                available_at = now() + make_interval(secs => least(3600, 30 * attempts))
              where id = ${r.id}`;
          }
        }
        return { published: rows.length };
      },
    },
    {
      // Songs Suno never delivered: fail the row and refund once (10-minute limit inside).
      queue: QUEUES.maintenance,
      name: 'sweep-stale-music',
      concurrency: 1,
      handle: async (_job, deps) => ({ swept: await sweepStaleMusic(deps) }),
    },
    {
      // Flight attempts stuck mid-booking: refund when TBO says no, flag for review when the outcome is unknown.
      queue: QUEUES.maintenance,
      name: 'sweep-stale-flight-bookings',
      concurrency: 1,
      handle: async (_job, deps) => sweepStaleFlightBookings(deps),
    },
  ],
  repeatables: [
    { queue: QUEUES.maintenance, name: 'purge-expired', cron: '17 3 * * *' },
    { queue: QUEUES.maintenance, name: 'drain-outbox', cron: '* * * * *' },
    { queue: QUEUES.maintenance, name: 'sweep-stale-music', cron: '*/2 * * * *' },
    { queue: QUEUES.maintenance, name: 'sweep-stale-flight-bookings', cron: '*/5 * * * *' },
  ],
};
