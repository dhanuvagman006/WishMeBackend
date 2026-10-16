/**
 * Job processors for the content queue (AI generation started by content-ai functions). See ../worker-types.ts.
 * Each processor re-reads its row and does nothing unless the row is still in progress, so duplicates and retries are
 * harmless; vendor failures are handled inside (row failed + ledger refund) instead of being retried.
 */
import { QUEUES } from '../queues.js';
import type { ProcessorModule } from '../worker-types.js';
import {
  CONTENT_JOBS,
  runGreetingCard,
  runImagePromotion,
  runWishCard,
  sweepStuck,
  type GreetingCardJob,
  type ImagePromotionJob,
} from '../../domains/content/generation.js';

export const module: ProcessorModule = {
  processors: [
    { queue: QUEUES.content, name: CONTENT_JOBS.greetingCard, concurrency: 4, handle: (job, deps) => runGreetingCard(deps, job.data as GreetingCardJob) },
    { queue: QUEUES.content, name: CONTENT_JOBS.imagePromotion, concurrency: 4, handle: (job, deps) => runImagePromotion(deps, job.data as ImagePromotionJob) },
    { queue: QUEUES.content, name: CONTENT_JOBS.wishCard, concurrency: 4, handle: (job, deps) => runWishCard(deps, String((job.data as { orderId: string }).orderId)) },
    { queue: QUEUES.content, name: CONTENT_JOBS.sweep, concurrency: 1, handle: (_job, deps) => sweepStuck(deps) },
  ],
  repeatables: [{ queue: QUEUES.content, name: CONTENT_JOBS.sweep, cron: '*/5 * * * *' }],
};
