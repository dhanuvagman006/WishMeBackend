/**
 * The phone side of Vobiz calls (ported from production functions/vobiz-call, supabase audit 2026-10-16):
 *
 *   GET  vobiz-call?a=ring       the phone started ringing
 *   GET  vobiz-call?a=answer     they picked up → VobizXML: record the session, open a two-way audio stream
 *   WS   vobiz-stream            the live conversation, bridged to Gemini Live or Sarvam
 *   GET  vobiz-call?a=hangup     the call is over
 *   GET  vobiz-call?a=recording  the recording is ready → copied into private storage by a job
 *
 * Every URL carries k=<kind>.<id>.<token>, an HMAC bound to the call (Vobiz cannot log in). Callbacks use GET
 * because the compat gateway parses POST bodies as JSON and Vobiz posts forms.
 *
 * ASSUMPTION: Vobiz sends Plivo-style callback parameters (CallStatus, HangupCause, Duration, RecordUrl,
 * RecordingDuration) in the query string for GET callbacks; the production code read RecordUrl/RecordFile and
 * RecordingDuration from the recording callback and ignored the others.
 */
import type { WebSocket } from 'ws';
import type { FnResult } from '../../compat/functions/registry.js';
import type { Deps } from '../../deps.js';
import { QUEUES } from '../../jobs/queues.js';
import type { Logger } from '../../lib/logger.js';
import { GeminiLive } from '../../vendors/gemini-live.js';
import { sarvamOf } from './sarvam-relay.js';
import {
  advanceAiCall,
  callbackUrl,
  cleanName,
  finishAiCall,
  isTerminal,
  normaliseLanguage,
  parseCallKey,
  settings,
  streamUrl,
  enqueueRecording,
  type FinishInput,
} from './ai-calls.js';
import { GeminiCallBridge, SarvamCallBridge, type CallBridge, type InboundFormat } from './call-bridges.js';
import type { CallBrief, CallLine } from './call-prompt.js';
import { wishCallback } from './voice-wishes.js';

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const xml = (body: string): FnResult => ({ raw: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, contentType: 'text/xml' });
const ok = (): FnResult => ({ raw: 'ok', contentType: 'text/plain' });

/** How a never-answered call ended, from the hangup callback. */
export function unansweredReason(q: URLSearchParams): 'busy' | 'failed' | 'customer-did-not-answer' {
  const s = `${q.get('CallStatus') ?? ''} ${q.get('HangupCause') ?? ''}`.toLowerCase();
  if (s.includes('busy')) return 'busy';
  if (/failed|invalid|unallocated|rejected/.test(s)) return 'failed';
  return 'customer-did-not-answer';
}

export const geminiLiveOf = (deps: Deps): GeminiLive => deps.memo('gemini-live', () => new GeminiLive(deps.env, deps.log));

export async function handleVobizCallback(deps: Deps, q: URLSearchParams): Promise<FnResult> {
  const key = parseCallKey(deps, q.get('k'));
  const action = q.get('a') ?? '';
  if (!key) return { status: 404, raw: 'Unknown call', contentType: 'text/plain' };
  if (key.kind === 'wish') return wishCallback(deps, key.id, action, q);

  const rows = await deps.db<{ id: string; status: string }[]>`select id::text, status from public.ai_calls where id = ${key.id}`;
  const row = rows[0];
  if (!row) return { status: 404, raw: 'Unknown call', contentType: 'text/plain' };
  switch (action) {
    case 'ring':
      await advanceAiCall(deps.db, row.id, 'ringing');
      return ok();
    case 'answer': {
      if (isTerminal(row.status)) return xml('<Hangup/>');
      await advanceAiCall(deps.db, row.id, 'in-progress');
      const record = (await settings(deps.db, ['ai_call_record'])).get('ai_call_record') !== 'false';
      // recordSession with redirect="false" records the whole call in the background while the stream runs.
      const rec = record
        ? `<Record recordSession="true" redirect="false" playBeep="false" fileFormat="mp3" maxLength="900" callbackUrl="${xmlEscape(callbackUrl(deps, 'ai', row.id, 'recording'))}" callbackMethod="GET"/>`
        : '';
      return xml(`${rec}<Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${xmlEscape(streamUrl(deps, row.id))}</Stream>`);
    }
    case 'hangup': {
      if (isTerminal(row.status)) return ok();
      if (row.status === 'in-progress') {
        // The live stream writes the result itself; hanging up closes it at the same moment, so only step in if it
        // never does.
        await deps.jobs.enqueue(QUEUES.calls, 'finish-stale-call', { callId: row.id }, { jobId: `ai-call:${row.id}:hangup`, delay: 30_000 });
        return ok();
      }
      await finishAiCall(deps, row.id, { answered: false, reason: unansweredReason(q), lines: [], outcome: null });
      return ok();
    }
    case 'recording': {
      const source = q.get('RecordUrl') || q.get('RecordFile') || '';
      const seconds = Math.round(Number(q.get('RecordingDuration')) || 0);
      if (source) await enqueueRecording(deps, row.id, source, seconds);
      return ok();
    }
    default:
      return { status: 404, raw: 'Not found', contentType: 'text/plain' };
  }
}

// ── the live conversation ────────────────────────────────────────────────────────────────────────────────────────

/** Wind-up and hard stop (production: ~380 s, told to wrap up 30 s before). */
export const CALL_LIMITS = { taskMs: 380_000, reminderMs: 170_000, wrapUpMs: 30_000 };

export async function runCallStream(deps: Deps, socket: WebSocket, k: string | null, log: Logger): Promise<void> {
  const key = parseCallKey(deps, k);
  if (!key || key.kind !== 'ai') {
    socket.close(4004, 'Unknown call');
    return;
  }
  // Vobiz sends `start` and audio the instant the stream opens: listen before any database work, hold early audio.
  let inbound: InboundFormat = { encoding: 'audio/x-mulaw', sampleRate: 8000 };
  let streamId: string | null = null;
  let bridge: CallBridge | null = null;
  let greeted = false;
  let ended = false;
  let playUntil = 0;
  const earlyAudio: string[] = [];
  const lines: CallLine[] = [];
  let outcome: FinishInput['outcome'] = null;
  const timers: NodeJS.Timeout[] = [];
  let seq = 0;
  let finishPromise: Promise<void> = Promise.resolve();

  const toPhone = (obj: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
  };
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    timers.forEach(clearTimeout);
    bridge?.close();
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    finishPromise = finishAiCall(deps, key.id, { answered: true, reason, lines, outcome }).catch((e: unknown) =>
      log.error({ callId: key.id, err: (e as Error).message }, 'ai call result not saved'),
    );
  };

  socket.on('message', (data) => {
    let msg: { event?: string; streamId?: string; start?: { streamId?: string; mediaFormat?: { encoding?: string; contentType?: string; sampleRate?: number } }; media?: { payload?: string } };
    try {
      msg = JSON.parse(String(data)) as typeof msg;
    } catch {
      return;
    }
    if (msg.event === 'start') {
      streamId = msg.start?.streamId ?? msg.streamId ?? null;
      const f = msg.start?.mediaFormat;
      if (f?.encoding || f?.contentType) inbound = { encoding: String(f.encoding ?? f.contentType), sampleRate: Number(f.sampleRate) || 8000 };
      bridge?.setInboundFormat(inbound);
      if (bridge && !greeted) {
        greeted = true;
        bridge.greet();
      }
    } else if (msg.event === 'media' && typeof msg.media?.payload === 'string') {
      if (bridge) bridge.onPhoneAudio(msg.media.payload);
      else if (earlyAudio.length < 400) earlyAudio.push(msg.media.payload);
    }
  });
  socket.on('close', () => end('customer-ended-call'));
  socket.on('error', () => end('engine-error-stream'));

  const rows = await deps.db<{ id: string; status: string; user_id: string; to_name: string | null; purpose: string; details: string | null; language: string; reminder: boolean }[]>`
    select c.id::text, c.status, c.user_id::text, c.to_name, c.purpose, c.details, c.language,
           exists (select 1 from public.reminders r where r.call_id = c.id) as reminder
    from public.ai_calls c where c.id = ${key.id}`;
  const row = rows[0];
  if (!row || isTerminal(row.status)) {
    ended = true;
    socket.close(4004, 'Unknown call');
    return;
  }
  const s = await settings(deps.db, ['ai_voice_engine', 'ai_voice_fallback', 'ai_call_record', 'ai_call_sarvam_speaker_english', 'ai_call_sarvam_speaker_hindi']);
  const profile = await deps.db<{ first_name: string | null; last_name: string | null }[]>`select first_name, last_name from public.profiles where user_id = ${row.user_id} limit 1`;
  const language = normaliseLanguage(row.language);
  const wanted = s.get('ai_voice_engine') === 'sarvam' ? 'sarvam' : 'gemini';
  // ASSUMPTION: speaker settings hold a Sarvam speaker name; the default voice is female (ritu).
  const speaker = (language === 'english' ? s.get('ai_call_sarvam_speaker_english') : s.get('ai_call_sarvam_speaker_hindi')) || 'ritu';
  const brief: CallBrief = {
    userName: cleanName(`${profile[0]?.first_name ?? ''} ${profile[0]?.last_name ?? ''}`) || 'a WishMe customer',
    toName: row.to_name ?? '',
    purpose: row.purpose,
    details: row.details ?? '',
    language,
    recorded: s.get('ai_call_record') !== 'false',
    gender: ['shubh', 'abhilash', 'karun', 'hitesh', 'aditya', 'rahul', 'rohan', 'amit'].includes(speaker) ? 'male' : 'female',
    kind: row.reminder ? 'reminder' : 'task',
  };
  const events = {
    onSpeak: (payload: string, ms: number) => {
      playUntil = Math.max(Date.now(), playUntil) + ms;
      toPhone({ event: 'playAudio', streamId, media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload } });
    },
    onClearAudio: () => {
      playUntil = 0;
      toPhone({ event: 'clearAudio', streamId });
    },
    onLine: (role: 'assistant' | 'user', text: string) => {
      const message = text.slice(0, 4000);
      lines.push({ role, message });
      const n = seq++;
      // Saved as it is spoken, so a dropped stream cannot lose the conversation and the app can follow it live.
      deps.db`insert into public.ai_call_lines (call_id, role, message, seq) values (${key.id}, ${role}, ${message}, ${n}) on conflict (call_id, seq) do nothing`.catch(
        (e: unknown) => log.warn({ callId: key.id, err: (e as Error).message }, 'call line not saved'),
      );
    },
    onOutcome: (args: Record<string, unknown>) => {
      outcome = args;
    },
    onWantsToHangUp: () => {
      // Let the goodbye finish playing before the line drops.
      const t = setTimeout(() => end('assistant-ended-call'), Math.max(0, playUntil - Date.now()) + 1200);
      timers.push(t);
    },
    onEnded: (reason: string) => end(reason),
  };
  const build = (engine: 'gemini' | 'sarvam'): CallBridge | null => {
    if (engine === 'sarvam') {
      const api = sarvamOf(deps);
      return api.configured ? new SarvamCallBridge(api, brief, speaker, events, log) : null;
    }
    const live = geminiLiveOf(deps);
    return live.configured ? new GeminiCallBridge(live, brief, 'Kore', events) : null;
  };
  const order: Array<'gemini' | 'sarvam'> = s.get('ai_voice_fallback') !== 'false' ? [wanted, wanted === 'gemini' ? 'sarvam' : 'gemini'] : [wanted];
  for (const engine of order) {
    if (ended) return;
    const candidate = build(engine);
    if (!candidate) continue;
    try {
      await candidate.start();
      bridge = candidate;
      break;
    } catch (e) {
      log.warn({ callId: key.id, engine, err: (e as Error).message }, 'call engine could not start');
      candidate.close();
    }
  }
  if (!bridge) return end('engine-error-no-engine');
  if (ended) {
    bridge.close();
    return;
  }
  bridge.setInboundFormat(inbound);
  if (!greeted) {
    greeted = true;
    bridge.greet();
  }
  for (const a of earlyAudio.splice(0)) bridge.onPhoneAudio(a);
  const limit = brief.kind === 'reminder' ? CALL_LIMITS.reminderMs : CALL_LIMITS.taskMs;
  timers.push(setTimeout(() => bridge?.say('Time is almost up. Wrap up now: say goodbye, call report_outcome, then call end_call.'), limit - CALL_LIMITS.wrapUpMs));
  timers.push(setTimeout(() => end('exceeded-max-duration'), limit));
  void finishPromise;
}
