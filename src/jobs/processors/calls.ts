/**
 * Calls queue: start scheduled AI calls and celebrity calls, copy recordings into private storage, close calls whose
 * stream never wrote a result, sweep calls that got stuck, and delete expired recordings.
 *
 * Every job is safe to run twice: dialling claims the row first, finishing only moves a call forward, refunds and
 * charges carry ledger idempotency keys, and recordings are keyed by call id.
 */
import { DIAL_FAILED, failAiCall, finishAiCall, isTerminal, placeAiCall, settings } from '../../domains/voice/ai-calls.js';
import type { CallLine } from '../../domains/voice/call-prompt.js';
import { b2Of, dispatchCelebrityCall, refundWish } from '../../domains/voice/voice-wishes.js';
import type { Deps } from '../../deps.js';
import { QUEUES } from '../queues.js';
import type { ProcessorModule } from '../worker-types.js';

const MAX_RECORDING_BYTES = 100 * 1024 * 1024;

async function linesOf(deps: Deps, callId: string): Promise<CallLine[]> {
  return deps.db<CallLine[]>`select role, message from public.ai_call_lines where call_id = ${callId} order by seq`;
}

/** Copies a finished recording into private storage and points the call at it (key, length, expiry). */
export async function storeRecording(deps: Deps, callId: string, source: string, seconds: number): Promise<{ stored: boolean }> {
  const b2 = b2Of(deps);
  if (!b2.configured) return { stored: false };
  const started = Date.now();
  // Binary download: lib/http.ts decodes non-JSON bodies as text, so this call keeps its guarantees itself
  // (timeout, size cap, status-only log line).
  const res = await fetch(source, { signal: AbortSignal.timeout(60_000) });
  deps.log.info({ vendor: 'vobiz', op: 'recording', status: res.status, ms: Date.now() - started }, 'vendor call');
  if (!res.ok) throw new Error(`could not download the recording (${res.status})`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_RECORDING_BYTES) throw new Error('recording too large');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_RECORDING_BYTES) throw new Error('recording too large');
  // The extension cannot be trusted (production saw WAV served as .mp3): the first bytes decide.
  const isWav = bytes.toString('ascii', 0, 4) === 'RIFF';
  const key = `ai-calls/${callId}.${isWav ? 'wav' : 'mp3'}`;
  await b2.putBuffer(key, bytes, isWav ? 'audio/wav' : 'audio/mpeg', true);
  const days = Math.max(1, Number((await settings(deps.db, ['ai_call_recording_days'])).get('ai_call_recording_days') ?? 30) || 30);
  await deps.db`
    update public.ai_calls set recording_url = ${key}, recording_seconds = ${seconds || null},
      recording_expires_at = now() + make_interval(days => ${days}), updated_at = now()
    where id = ${callId}`;
  return { stored: true };
}

export async function sweepStuckCalls(deps: Deps): Promise<Record<string, number>> {
  const out = { failed: 0, unanswered: 0, closed: 0, restarted: 0, wishesRestarted: 0, wishesFailed: 0 };
  // Dialled (or claimed) but no ring or answer for ten minutes.
  const stuck = await deps.db<{ id: string; status: string; vapi_call_id: string | null }[]>`
    select id::text, status, vapi_call_id from public.ai_calls
    where status in ('queued', 'ringing') and updated_at < now() - interval '10 minutes' limit 200`;
  for (const c of stuck) {
    if (c.status === 'ringing') {
      await finishAiCall(deps, c.id, { answered: false, reason: 'customer-did-not-answer', lines: [], outcome: null });
      out.unanswered++;
    } else {
      await failAiCall(deps.db, c.id, c.vapi_call_id && !c.vapi_call_id.startsWith('pending:') ? 'The phone service did not start the call.' : DIAL_FAILED, 'stuck');
      out.failed++;
    }
  }
  // Answered, but nothing closed it (the stream and its hangup check were both lost).
  const live = await deps.db<{ id: string }[]>`
    select id::text from public.ai_calls where status = 'in-progress' and coalesce(started_at, updated_at) < now() - interval '15 minutes' limit 200`;
  for (const c of live) {
    await finishAiCall(deps, c.id, { answered: true, reason: 'customer-ended-call', lines: await linesOf(deps, c.id), outcome: null });
    out.closed++;
  }
  // Scheduled calls whose job was lost (queues are re-derivable from the database).
  const late = await deps.db<{ id: string; very_late: boolean }[]>`
    select id::text, scheduled_for < now() - interval '30 minutes' as very_late from public.ai_calls
    where status = 'scheduled' and scheduled_for < now() - interval '2 minutes' limit 200`;
  for (const c of late) {
    if (c.very_late) {
      await failAiCall(deps.db, c.id, 'The scheduled call could not be started.', 'schedule-missed');
      out.failed++;
    } else {
      await deps.jobs.enqueue(QUEUES.calls, 'start-scheduled-call', { callId: c.id }, { jobId: `ai-call:${c.id}:sweep` });
      out.restarted++;
    }
  }
  const wishes = await deps.db<{ id: string; call_status: string; very_late: boolean }[]>`
    select id::text, call_status, coalesce(scheduled_at, created_at) < now() - interval '30 minutes' as very_late
    from public.voice_call_wishes
    where (call_status = 'scheduled' and scheduled_at < now() - interval '2 minutes')
       or (call_status = 'dialling' and coalesce(scheduled_at, created_at) < now() - interval '15 minutes')
    limit 200`;
  for (const w of wishes) {
    if (w.call_status === 'dialling' || w.very_late) {
      await deps.db`update public.voice_call_wishes set call_status = 'failed', error_message = 'The call could not be placed.' where id = ${w.id} and call_status in ('scheduled', 'dialling')`;
      await refundWish(deps, w.id, 'the call could not be placed');
      out.wishesFailed++;
    } else {
      await deps.jobs.enqueue(QUEUES.calls, 'start-voice-call-wish', { wishId: w.id }, { jobId: `voice-call-wish:${w.id}:sweep` });
      out.wishesRestarted++;
    }
  }
  return out;
}

/** Deletes recordings past their expiry; the written conversation stays, and the app gets 410 for the audio. */
export async function expireRecordings(deps: Deps): Promise<{ removed: number }> {
  const b2 = b2Of(deps);
  if (!b2.configured) return { removed: 0 };
  const rows = await deps.db<{ id: string; recording_url: string }[]>`
    select id::text, recording_url from public.ai_calls
    where recording_url is not null and recording_url not like 'expired:%' and recording_url not like 'http%'
      and recording_expires_at < now() limit 200`;
  for (const r of rows) {
    await b2.remove(r.recording_url, true);
    await deps.db`update public.ai_calls set recording_url = ${`expired:${r.recording_url}`}, updated_at = now() where id = ${r.id}`;
  }
  return { removed: rows.length };
}

export const module: ProcessorModule = {
  processors: [
    {
      queue: QUEUES.calls,
      name: 'start-scheduled-call',
      concurrency: 5,
      handle: async (job, deps) => {
        const callId = String((job.data as { callId?: string }).callId ?? '');
        return callId ? placeAiCall(deps, callId, 'task') : { skipped: 'no callId' };
      },
    },
    {
      queue: QUEUES.calls,
      name: 'start-voice-call-wish',
      handle: async (job, deps) => {
        const wishId = String((job.data as { wishId?: string }).wishId ?? '');
        return wishId ? dispatchCelebrityCall(deps, wishId) : { skipped: 'no wishId' };
      },
    },
    {
      queue: QUEUES.calls,
      name: 'store-recording',
      handle: async (job, deps) => {
        const d = job.data as { callId?: string; source?: string; seconds?: number };
        if (!d.callId || !d.source) return { skipped: 'bad job data' };
        return storeRecording(deps, d.callId, d.source, Number(d.seconds) || 0);
      },
    },
    {
      queue: QUEUES.calls,
      name: 'finish-stale-call',
      handle: async (job, deps) => {
        const callId = String((job.data as { callId?: string }).callId ?? '');
        const rows = await deps.db<{ status: string }[]>`select status from public.ai_calls where id = ${callId}`;
        if (!rows[0] || isTerminal(rows[0].status)) return { skipped: 'already finished' };
        await finishAiCall(deps, callId, { answered: rows[0].status === 'in-progress', reason: rows[0].status === 'in-progress' ? 'customer-ended-call' : 'customer-did-not-answer', lines: await linesOf(deps, callId), outcome: null });
        return { finished: true };
      },
    },
    { queue: QUEUES.calls, name: 'sweep-stuck-calls', concurrency: 1, handle: async (_job, deps) => sweepStuckCalls(deps) },
    { queue: QUEUES.calls, name: 'expire-recordings', concurrency: 1, handle: async (_job, deps) => expireRecordings(deps) },
  ],
  repeatables: [
    { queue: QUEUES.calls, name: 'sweep-stuck-calls', cron: '*/5 * * * *' },
    { queue: QUEUES.calls, name: 'expire-recordings', cron: '41 2 * * *' },
  ],
};
