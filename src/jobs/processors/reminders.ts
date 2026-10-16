/**
 * Reminders queue: the minute-by-minute dispatcher and the reminder calls it starts. See domains/hub/reminders.ts.
 */
import { enqueuePush, dispatchReminders } from '../../domains/hub/reminders.js';
import { placeAiCall } from '../../domains/voice/ai-calls.js';
import { QUEUES } from '../queues.js';
import type { ProcessorModule } from '../worker-types.js';

export const module: ProcessorModule = {
  processors: [
    {
      queue: QUEUES.reminders,
      name: 'dispatch-due',
      concurrency: 1,
      handle: async (_job, deps) => dispatchReminders(deps),
    },
    {
      queue: QUEUES.reminders,
      name: 'reminder-call',
      concurrency: 5,
      handle: async (job, deps) => {
        const { callId, reminderId } = job.data as { callId?: string; reminderId?: string };
        if (!callId || !reminderId) return { skipped: 'bad job data' };
        const result = await placeAiCall(deps, callId, 'reminder');
        if (!result.placed) {
          // The phone service refused: fall back to a push so the reminder still reaches the user.
          const rows = await deps.db<{ id: string; user_id: string; title: string; notes: string | null; due_at: string | null; style: string; event_id: string | null }[]>`
            select id::text, user_id::text, title, notes, to_json(due_at) #>> '{}' as due_at, style, event_id::text from public.reminders where id = ${reminderId}`;
          if (rows[0]) await enqueuePush(deps, rows[0], `${rows[0].id}:${rows[0].due_at ?? 'none'}:call-failed`);
        }
        return result;
      },
    },
  ],
  repeatables: [{ queue: QUEUES.reminders, name: 'dispatch-due', cron: '* * * * *' }],
};
