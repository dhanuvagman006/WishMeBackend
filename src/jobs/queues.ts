/**
 * Background jobs. Producers call `jobs.enqueue(queue, name, data, opts)`; processors live in ./processors and run in
 * the worker process. Every job is idempotent: give it a deterministic `jobId` (e.g. `reminder:<id>:<dueAt>`) so a retry
 * or a duplicate enqueue never does the work twice.
 */
import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

export const QUEUES = {
  /** Reminders and calendar: dispatch calls and escalations at the right time. */
  reminders: 'reminders',
  /** AI phone calls (Vapi): start scheduled calls, sweep stuck ones. */
  calls: 'calls',
  /** AI content generation and vendor polling (music, cards, photo wishes, videos). */
  content: 'content',
  /** Emails, WhatsApp, push and in-app messages. */
  notifications: 'notifications',
  /** Payment reconciliation and ledger invariants. */
  payments: 'payments',
  /** Housekeeping (expired tokens, OTPs, outbox). */
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface Jobs {
  enqueue(queue: QueueName, name: string, data: Record<string, unknown>, opts?: JobsOptions): Promise<void>;
  close(): Promise<void>;
}

const DEFAULTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 24 * 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export class BullJobs implements Jobs {
  private readonly queues = new Map<string, Queue>();

  constructor(
    private readonly connection: Redis,
    private readonly prefix: string,
  ) {}

  private queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, prefix: `${this.prefix}:bull`, defaultJobOptions: DEFAULTS });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue(queue: QueueName, name: string, data: Record<string, unknown>, opts?: JobsOptions): Promise<void> {
    await this.queue(queue).add(name, data, opts);
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/** Records jobs instead of running them (tests, and development without Redis). */
export class MemoryJobs implements Jobs {
  readonly enqueued: Array<{ queue: QueueName; name: string; data: Record<string, unknown>; opts?: JobsOptions }> = [];
  async enqueue(queue: QueueName, name: string, data: Record<string, unknown>, opts?: JobsOptions): Promise<void> {
    if (opts?.jobId && this.enqueued.some((j) => j.queue === queue && j.opts?.jobId === opts.jobId)) return;
    this.enqueued.push({ queue, name, data, ...(opts ? { opts } : {}) });
  }
  async close(): Promise<void> {}
}
