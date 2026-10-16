/**
 * Job processors for the notifications queue. See ../worker-types.ts.
 *
 * Job data contracts (enqueue with deps.jobs.enqueue('notifications', <name>, data, { jobId: <deterministic id> })):
 *
 *   send-email     { to: string (email address), subject: string (≤ 200), text: string (≤ 20 000), html?: string (≤ 100 000) }
 *                  Sent through deps.mailer. Retried with the queue's backoff on failure.
 *
 *   send-whatsapp  { to: string (E.164, or an Indian mobile in any common spelling), template: string (approved template
 *                    name), language?: string (default 'en'), params?: string[] (body parameters, ≤ 10) }
 *                  WhatsApp Cloud API template message. Skipped (completed, not failed) when WHATSAPP_PROVIDER is not
 *                  'meta'. Not idempotent at the vendor: give the job a deterministic jobId.
 *
 *   push           { userId: string (auth.users.id, NOT profiles.id), title: string (≤ 100), body: string (≤ 500),
 *                    data?: object (≤ 4 KB as JSON) }
 *                  Expo push to every token in public.push_tokens for that auth user. Tokens Expo reports as
 *                  DeviceNotRegistered are deleted. Skipped when the user has no tokens.
 *
 * Malformed data fails the job permanently (UnrecoverableError) instead of retrying.
 */
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { e164India } from '../../domains/accounts/phone.js';
import { ExpoPush, type PushMessage } from '../../vendors/expo-push.js';
import { WhatsApp } from '../../vendors/whatsapp.js';
import { QUEUES } from '../queues.js';
import type { ProcessorModule } from '../worker-types.js';

export const SendEmailJob = z.object({
  to: z.string().trim().email().max(254),
  subject: z.string().min(1).max(200),
  text: z.string().min(1).max(20_000),
  html: z.string().max(100_000).optional(),
});

export const SendWhatsAppJob = z.object({
  to: z.string().min(8).max(20),
  template: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default('en'),
  params: z.array(z.string().max(500)).max(10).optional(),
});

export const PushJob = z.object({
  userId: z.string().uuid(),
  title: z.string().min(1).max(100),
  body: z.string().min(1).max(500),
  data: z
    .record(z.unknown())
    .refine((d) => JSON.stringify(d).length <= 4096, 'data too large')
    .optional(),
});

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown, job: string): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new UnrecoverableError(`${job}: invalid job data (${r.error.issues[0]?.path.join('.') ?? ''}: ${r.error.issues[0]?.message ?? ''})`);
  return r.data;
}

export const module: ProcessorModule = {
  processors: [
    {
      queue: QUEUES.notifications,
      name: 'send-email',
      concurrency: 5,
      handle: async (job, deps) => {
        const m = parse(SendEmailJob, job.data, 'send-email');
        await deps.mailer.send({ to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) });
        return { sent: true };
      },
    },
    {
      queue: QUEUES.notifications,
      name: 'send-whatsapp',
      concurrency: 3,
      handle: async (job, deps) => {
        const m = parse(SendWhatsAppJob, job.data, 'send-whatsapp');
        const wa = deps.memo('whatsapp', () => new WhatsApp(deps.env, deps.log));
        if (!wa.configured) return { skipped: 'whatsapp not configured' };
        const to = m.to.startsWith('+') && !m.to.startsWith('+91') ? m.to.replace(/[^\d+]/g, '') : e164India(m.to);
        if (!to || !/^\+\d{8,15}$/.test(to)) throw new UnrecoverableError('send-whatsapp: invalid phone number');
        const id = await wa.sendTemplate({ to, template: m.template, language: m.language, ...(m.params ? { params: m.params } : {}) });
        return { sent: true, id };
      },
    },
    {
      queue: QUEUES.notifications,
      name: 'push',
      concurrency: 5,
      handle: async (job, deps) => {
        const m = parse(PushJob, job.data, 'push');
        if (!deps.schema.table('push_tokens') && deps.schema.isLoaded) return { skipped: 'no push_tokens table' };
        const tokens = await deps.db<{ token: string }[]>`
          select token from public.push_tokens where user_id = ${m.userId} order by last_seen_at desc nulls last limit 20`;
        if (tokens.length === 0) return { skipped: 'no tokens' };
        const messages: PushMessage[] = tokens.map((t) => ({ to: t.token, title: m.title, body: m.body, ...(m.data ? { data: m.data } : {}) }));
        const tickets = await deps.memo('expo-push', () => new ExpoPush(deps.log)).send(messages);
        const dead = tickets.flatMap((t, i) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? [tokens[i]!.token] : []));
        if (dead.length) await deps.db`delete from public.push_tokens where token = any(${dead}::text[])`;
        const sent = tickets.filter((t) => t.status === 'ok').length;
        return { sent, failed: tickets.length - sent, removed: dead.length };
      },
    },
  ],
  repeatables: [],
};
