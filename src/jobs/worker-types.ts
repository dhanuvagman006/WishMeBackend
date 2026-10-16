import type { Job } from 'bullmq';
import type { Deps } from '../deps.js';
import type { QueueName } from './queues.js';

export interface ProcessorDef {
  queue: QueueName;
  /** Job name this processor handles. */
  name: string;
  /** Max jobs of this queue processed concurrently by one worker (default 5). Keep vendor limits in mind. */
  concurrency?: number;
  handle: (job: Job, deps: Deps) => Promise<unknown>;
}

export interface RepeatableDef {
  queue: QueueName;
  name: string;
  /** Cron pattern (UTC), e.g. '* * * * *' every minute. */
  cron: string;
  data?: Record<string, unknown>;
}

export interface ProcessorModule {
  processors: ProcessorDef[];
  repeatables: RepeatableDef[];
}
