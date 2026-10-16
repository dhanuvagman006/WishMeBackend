/**
 * Voice-call wishes, written to public.voice_call_wishes (owner = profiles.id; the Bookings "Calls" tab reads it):
 *
 *  - Celebrity calls (vapi-celebrity-call). Production (supabase audit 2026-10-16) rendered a greeting in the
 *    celebrity's ElevenLabs voice, stored it publicly on B2 and rang the recipient through Vobiz, which played it;
 *    scheduled ones were left for process-scheduled-calls. Here both go the same way: the greeting is stored
 *    privately and Vobiz fetches it through a short-lived signed link; a scheduled call is a delayed job.
 *  - AI voice wishes in a chosen voice (vapi-make-call): a live Vapi call with that voice, as in production.
 *
 * Money (ADR 0004): the price is the server's (celebrities.voice_call_price, plan discount applied; ₹100 for a voice
 * wish as production charged), debited through the ledger in the same transaction that creates the row, and refunded
 * through the ledger when the call cannot be placed. Kinds follow production's history rows: 'voice_call' for
 * celebrity calls, 'voice_call_wish' for voice wishes. Commissions for a completed celebrity call are still paid by
 * the database triggers on voice_call_wishes (credit_celebrity_on_voice_call_complete,
 * process_voice_call_referral_commission) in shared mode, exactly as today.
 */
import { randomUUID } from 'node:crypto';
import type { FnResult } from '../../compat/functions/registry.js';
import type { Deps } from '../../deps.js';
import { QUEUES } from '../../jobs/queues.js';
import type { Tx } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { B2 } from '../../vendors/b2.js';
import { ElevenLabs } from '../../vendors/elevenlabs.js';
import { Vapi, type VapiCall } from '../../vendors/vapi.js';
import { discounted, planDiscountPercent } from '../pricing.js';
import { markMirrorable } from '../wallet/mirrors.js';
import { callbackUrl, cleanName, cleanText, isTerminal, rankOf, vobizOf } from './ai-calls.js';

export const vapiOf = (deps: Deps): Vapi => deps.memo('vapi', () => new Vapi(deps.env, deps.log));
export const b2Of = (deps: Deps): B2 => deps.memo('b2', () => new B2(deps.env));
export const elevenOf = (deps: Deps): ElevenLabs => deps.memo('elevenlabs', () => new ElevenLabs(deps.env, deps.log));

/** Production: a celebrity without voice_call_price costs ₹500; a voice wish costs ₹100 (vapi-make-call CALL_PRICE). */
export const DEFAULT_CELEBRITY_CALL_PRICE = 500;
export const VOICE_WISH_PRICE = 100;

interface WishRow {
  id: string;
  user_id: string;
  call_status: string | null;
  price_paid: number;
  call_config: Record<string, unknown> | null;
  recipient_phone: string;
  recipient_name: string;
  occasion: string;
  sender_name: string | null;
  vapi_voice_id: string;
  vapi_voice_name: string | null;
  celebrity_id: string | null;
}

// ── money ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function debit(deps: Deps, tx: Tx, w: { id: string; profileId: string; userId: string; pricePaise: number; kind: string; description: string }): Promise<void> {
  await deps.ledger.apply(tx, 'user_wallet', {
    accountId: w.profileId,
    deltaPaise: -w.pricePaise,
    kind: w.kind,
    idempotencyKey: `voice_call_wish:${w.id}:debit`,
    createdBy: w.userId,
    description: w.description,
    paymentMethod: 'wallet',
    details: markMirrorable({ service_type: w.kind, order_id: w.id }),
    reference: { type: 'voice_call_wish', id: w.id },
  });
}

/** Returns the money for a wish that could not be placed (once, whatever retries happen). */
export async function refundWish(deps: Deps, wishId: string, reason: string): Promise<void> {
  const rows = await deps.db<{ user_id: string; price_paid: number }[]>`select user_id::text, price_paid from public.voice_call_wishes where id = ${wishId}`;
  const w = rows[0];
  if (!w || !(Number(w.price_paid) > 0)) return;
  // Only refund what this server charged (a ledger debit exists for the wish).
  const charged = await deps.db`select 1 from wishme.ledger_entries where idempotency_key = ${`voice_call_wish:${wishId}:debit`}`;
  if (!charged.length) return;
  await deps.ledger.run('user_wallet', {
    accountId: w.user_id,
    deltaPaise: Number(w.price_paid) * 100,
    kind: 'refund',
    idempotencyKey: `voice_call_wish:${wishId}:refund`,
    createdBy: 'system',
    description: `Refund: ${reason}`,
    paymentMethod: 'system',
    details: { service_type: 'voice_call_wish', order_id: wishId },
    reference: { type: 'voice_call_wish', id: wishId },
  });
}

async function failWish(deps: Deps, wishId: string, message: string): Promise<void> {
  await deps.db`
    update public.voice_call_wishes set call_status = 'failed', error_message = ${message.slice(0, 300)}
    where id = ${wishId} and coalesce(call_status, '') not in ('completed', 'no-answer', 'busy', 'voicemail', 'failed')`;
  await refundWish(deps, wishId, 'the call could not be placed');
}

// ── celebrity calls ──────────────────────────────────────────────────────────────────────────────────────────────

export interface CelebrityCallInput {
  userId: string;
  profileId: string;
  celebrityId: string;
  recipientName: string;
  recipientPhone: string;
  occasion: string;
  senderName: string;
  clientPrice: number | null;
  config: { customMessage: string; tone: string; relationship: string; language: string; thingsToAvoid: string; additionalContext: string };
  scheduledAt: Date | null;
}

export async function bookCelebrityCall(deps: Deps, input: CelebrityCallInput): Promise<{ wishId: string; celebrityName: string; scheduled: boolean }> {
  const celeb = await deps.db<{ id: string; name: string; vapi_voice_id: string | null; voice_call_price: number | null; is_active: boolean | null }[]>`
    select id::text, name, vapi_voice_id, voice_call_price, is_active from public.celebrities where id = ${input.celebrityId}`;
  const c = celeb[0];
  if (!c || c.is_active === false || !c.vapi_voice_id?.trim()) {
    throw new AppError(400, 'not_available', 'This celebrity is not yet set up for voice calls. Please choose another.');
  }
  // Production required an active favourite subscription to the celebrity (celebrity_favorites).
  const sub = await deps.db`
    select 1 from public.celebrity_favorites
    where celebrity_id = ${c.id} and user_id = any(${[input.profileId, input.userId]}::uuid[]) and coalesce(status, 'active') = 'active' limit 1`;
  if (!sub.length) {
    throw new AppError(403, 'subscription_required', `You must be subscribed to ${c.name} before booking a call. Please subscribe from their profile first.`, {
      subscriptionRequired: true,
    });
  }
  const base = Number(c.voice_call_price) > 0 ? Math.floor(Number(c.voice_call_price)) : DEFAULT_CELEBRITY_CALL_PRICE;
  const pricePaise = discounted(base * 100, await planDiscountPercent(deps.db, input.profileId));
  // The screen showed a price; never charge more than that without asking again.
  if (input.clientPrice !== null && pricePaise > Math.round(input.clientPrice * 100)) {
    throw new AppError(409, 'price_changed', 'The price has changed. Please refresh and try again.');
  }
  const wishId = randomUUID();
  const scheduled = input.scheduledAt !== null;
  await deps.db.begin(async (tx) => {
    await tx`
      insert into public.voice_call_wishes
        (id, user_id, recipient_name, recipient_phone, occasion, celebrity_id, sender_name, vapi_voice_id, vapi_voice_name,
         call_status, price_paid, scheduled_at, call_config)
      values (${wishId}, ${input.profileId}, ${input.recipientName}, ${input.recipientPhone}, ${input.occasion}, ${c.id},
              ${input.senderName}, ${c.vapi_voice_id!.trim()}, ${c.name}, ${scheduled ? 'scheduled' : 'initiated'}, ${pricePaise / 100},
              ${input.scheduledAt ? input.scheduledAt.toISOString() : null}, ${JSON.stringify({ ...input.config, kind: 'celebrity' })}::text::jsonb)`;
    await debit(deps, tx, {
      id: wishId,
      profileId: input.profileId,
      userId: input.userId,
      pricePaise,
      kind: 'voice_call',
      description: `${scheduled ? 'Scheduled celebrity' : 'Celebrity'} voice call: ${c.name} to ${input.recipientName}`.slice(0, 200),
    });
  });
  if (scheduled) {
    await deps.jobs.enqueue(QUEUES.calls, 'start-voice-call-wish', { wishId }, { jobId: `voice-call-wish:${wishId}`, delay: Math.max(0, input.scheduledAt!.getTime() - Date.now()) });
  }
  return { wishId, celebrityName: c.name, scheduled };
}

/** The greeting the celebrity's voice reads. User text is cleaned and bounded; the voice reads it, nothing executes it. */
export function wishScript(w: { recipient: string; celebrity: string; sender: string; occasion: string; relationship: string; message: string; language: string }): string {
  const msg = w.message ? ` ${w.message.replace(/[.!?]*$/, '')}.` : '';
  if (w.language === 'hindi') {
    return `नमस्ते ${w.recipient}! मैं ${w.celebrity}। आपके ${w.relationship || 'अपने'} ${w.sender} ने आपके ${w.occasion} पर आपको शुभकामनाएँ भेजी हैं।${msg} आपका दिन ख़ुशियों से भरा हो!`;
  }
  return `Hello ${w.recipient}! This is ${w.celebrity}. Your ${w.relationship || 'friend'} ${w.sender} asked me to call and wish you a very happy ${w.occasion}!${msg} Wishing you lots of happiness and success. Have a wonderful day!`;
}

/**
 * Places a celebrity call now: renders the greeting, stores it privately, rings through Vobiz. Claims the row first
 * (call_status scheduled/initiated → dialling) so a retried job never rings twice. On failure the row is failed and
 * the money refunded.
 */
export async function dispatchCelebrityCall(deps: Deps, wishId: string): Promise<{ placed: boolean; error?: string }> {
  const rows = await deps.db<WishRow[]>`
    update public.voice_call_wishes set call_status = 'dialling'
    where id = ${wishId} and call_status in ('scheduled', 'initiated') and vapi_call_id is null
    returning id::text, user_id::text, call_status, price_paid, call_config, recipient_phone, recipient_name, occasion, sender_name,
              vapi_voice_id, vapi_voice_name, celebrity_id::text`;
  const w = rows[0];
  if (!w) return { placed: true };
  const cfg = (w.call_config ?? {}) as Record<string, string>;
  try {
    const script = wishScript({
      recipient: cleanName(w.recipient_name),
      celebrity: cleanName(w.vapi_voice_name ?? 'your favourite star'),
      sender: cleanName(w.sender_name ?? 'someone special'),
      occasion: cleanText(w.occasion, 60),
      relationship: cleanText(cfg.relationship, 40),
      message: cleanText(cfg.customMessage, 400),
      language: cleanText(cfg.language, 20).toLowerCase(),
    });
    const audio = await elevenOf(deps).textToSpeech(w.vapi_voice_id.trim(), script);
    const key = `voice-call-wishes/${w.id}.mp3`;
    await b2Of(deps).putBuffer(key, audio, 'audio/mpeg', true);
    await deps.db`update public.voice_call_wishes set call_config = coalesce(call_config, '{}'::jsonb) || ${JSON.stringify({ audioKey: key })}::text::jsonb where id = ${w.id}`;
    const placed = await vobizOf(deps).placeCall({
      to: w.recipient_phone,
      answerUrl: callbackUrl(deps, 'wish', w.id, 'answer'),
      ringUrl: callbackUrl(deps, 'wish', w.id, 'ring'),
      hangupUrl: callbackUrl(deps, 'wish', w.id, 'hangup'),
      timeLimitSeconds: 180,
    });
    await deps.db`update public.voice_call_wishes set vapi_call_id = ${placed.id}, call_status = 'initiated' where id = ${w.id} and call_status = 'dialling'`;
    return { placed: true };
  } catch (e) {
    deps.log.warn({ wishId, err: (e as Error).message }, 'celebrity call could not be placed');
    await failWish(deps, w.id, 'The call could not be placed.');
    return { placed: false, error: 'Telecom line error: Could not connect call' };
  }
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xml = (body: string): FnResult => ({ raw: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, contentType: 'text/xml' });
const ok = (): FnResult => ({ raw: 'ok', contentType: 'text/plain' });

/** Vobiz callbacks for a celebrity call (ring / answer / hangup). */
export async function wishCallback(deps: Deps, wishId: string, action: string, q: URLSearchParams): Promise<FnResult> {
  const rows = await deps.db<{ id: string; call_status: string | null; call_config: Record<string, unknown> | null }[]>`
    select id::text, call_status, call_config from public.voice_call_wishes where id = ${wishId}`;
  const w = rows[0];
  if (!w) return { status: 404, raw: 'Unknown call', contentType: 'text/plain' };
  const forward = async (status: string, extra: { completed?: boolean; seconds?: number | null; reason?: string | null } = {}) => {
    if (rankOf(w.call_status) >= rankOf(status)) return;
    await deps.db`
      update public.voice_call_wishes set call_status = ${status},
        completed_at = case when ${!!extra.completed} then now() else completed_at end,
        call_duration_seconds = coalesce(${extra.seconds ?? null}::int, call_duration_seconds),
        disconnect_reason = coalesce(${extra.reason ?? null}, disconnect_reason)
      where id = ${w.id} and coalesce(call_status, '') not in ('completed', 'no-answer', 'busy', 'voicemail', 'failed')`;
  };
  switch (action) {
    case 'ring':
      await forward('ringing');
      return ok();
    case 'answer': {
      if (isTerminal(w.call_status)) return xml('<Hangup/>');
      await forward('in-progress');
      const key = typeof w.call_config?.audioKey === 'string' ? w.call_config.audioKey : '';
      if (key) {
        const url = await b2Of(deps).signedGetUrl(key, { isPrivate: true, expiresSec: 900 });
        return xml(`<Wait length="1"/><Play>${xmlEscape(url)}</Play>`);
      }
      return xml('<Wait length="1"/><Speak voice="WOMAN" language="en-IN">Hello, this is a special celebrity wish for you. Have a wonderful day!</Speak>');
    }
    case 'hangup': {
      const seconds = Math.round(Number(q.get('Duration') ?? q.get('BillDuration')) || 0) || null;
      const cause = (q.get('HangupCause') ?? q.get('CallStatus') ?? '').slice(0, 100) || null;
      if (w.call_status === 'in-progress') {
        // 'completed' is what releases the celebrity's commission (database trigger): only a call that was answered.
        await forward('completed', { completed: true, seconds, reason: cause });
      } else {
        const s = `${q.get('CallStatus') ?? ''} ${q.get('HangupCause') ?? ''}`.toLowerCase();
        await forward(s.includes('busy') ? 'busy' : /failed|invalid|rejected/.test(s) ? 'failed' : 'no-answer', { reason: cause });
      }
      return ok();
    }
    default:
      return { status: 404, raw: 'Not found', contentType: 'text/plain' };
  }
}

// ── voice wishes through Vapi ────────────────────────────────────────────────────────────────────────────────────

const ELEVEN_LANG: Record<string, string> = {
  kannada: 'kn', tamil: 'ta', telugu: 'te', hindi: 'hi', malayalam: 'ml', bengali: 'bn', gujarati: 'gu', marathi: 'mr', punjabi: 'pa', english: 'en',
};

export interface VoiceWishInput {
  userId: string;
  profileId: string;
  recipientName: string;
  recipientPhone: string;
  occasion: string;
  voiceId: string;
  voiceName: string;
  language: string;
}

/** The caller's own voices plus the organisation's shared ones (never another user's clone). */
export async function voicesFor(deps: Deps, profileId: string): Promise<{ vapiVoices: Array<{ id: string; name: string; provider: string }>; userVoices: Array<Record<string, unknown>> }> {
  const all = await vapiOf(deps).listVoices();
  const owned = await deps.db<{ vapi_voice_id: string; user_id: string }[]>`select vapi_voice_id, user_id::text from public.user_vapi_voices`;
  const othersOrMine = new Set(owned.map((o) => o.vapi_voice_id));
  const userVoices = await deps.db`
    select id::text, vapi_voice_id, voice_name, created_at from public.user_vapi_voices where user_id = ${profileId} order by created_at desc limit 50`;
  return { vapiVoices: all.filter((v) => !othersOrMine.has(v.id)), userVoices: [...userVoices] };
}

export async function placeVoiceWish(deps: Deps, input: VoiceWishInput): Promise<{ wishId: string }> {
  const vapi = vapiOf(deps);
  if (!vapi.configured) throw new AppError(503, 'unavailable', 'Voice calls are not available right now.');
  const mine = await deps.db`select 1 from public.user_vapi_voices where user_id = ${input.profileId} and vapi_voice_id = ${input.voiceId} limit 1`;
  if (!mine.length) {
    const shared = (await voicesFor(deps, input.profileId)).vapiVoices.some((v) => v.id === input.voiceId);
    if (!shared) throw new AppError(400, 'invalid_voice', 'Please choose one of the available voices.');
  }
  const wishId = randomUUID();
  const pricePaise = VOICE_WISH_PRICE * 100;
  await deps.db.begin(async (tx) => {
    await tx`
      insert into public.voice_call_wishes (id, user_id, recipient_name, recipient_phone, occasion, vapi_voice_id, vapi_voice_name, call_status, price_paid, call_config)
      values (${wishId}, ${input.profileId}, ${input.recipientName}, ${input.recipientPhone}, ${input.occasion}, ${input.voiceId}, ${input.voiceName || null},
              'initiated', ${VOICE_WISH_PRICE}, ${JSON.stringify({ kind: 'voice_wish', language: input.language })}::text::jsonb)`;
    await debit(deps, tx, {
      id: wishId,
      profileId: input.profileId,
      userId: input.userId,
      pricePaise,
      kind: 'voice_call_wish',
      description: `Voice call wish - ${input.occasion} for ${input.recipientName}`.slice(0, 200),
    });
  });
  const lang = input.language.toLowerCase();
  const english = lang === 'english' || !ELEVEN_LANG[lang];
  const langName = english ? 'English' : lang.charAt(0).toUpperCase() + lang.slice(1);
  const system = [
    `You are making a short celebratory phone call to ${input.recipientName} for their ${input.occasion}.`,
    `Speak ${langName}${english ? '' : `, in ${langName} script, not transliterated`}.`,
    'Sound warm, friendly and natural, not scripted or sales-like. Give a heartfelt wish and keep the call to 30 to 60 seconds.',
    'Do not volunteer that you are an AI, but never claim to be human: if asked, say honestly that this is an AI voice.',
    'Never ask for money, codes or personal details. If they want to end the call, say goodbye.',
  ].join('\n');
  let call: VapiCall;
  try {
    call = await vapi.createCall({
      customer: { number: input.recipientPhone, name: input.recipientName.slice(0, 40) },
      metadata: { voiceCallWishId: wishId },
      assistant: {
        name: `${input.occasion} Wisher`.slice(0, 40),
        firstMessageMode: 'assistant-speaks-first',
        firstMessage: english ? `Hey ${input.recipientName}, this call is just for you: happy ${input.occasion}!` : `${input.recipientName}! Happy ${input.occasion}!`,
        model: { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'system', content: system }] },
        voice: { provider: '11labs', voiceId: input.voiceId, model: 'eleven_v3', ...(ELEVEN_LANG[lang] ? { language: ELEVEN_LANG[lang] } : {}) },
        endCallPhrases: ['goodbye', 'bye', 'thank you', 'thanks'],
        maxDurationSeconds: 120,
        server: vapi.serverConfig(),
        serverMessages: ['status-update', 'end-of-call-report'],
      },
    });
  } catch (e) {
    deps.log.warn({ wishId, err: (e as Error).message }, 'voice wish could not be placed');
    await failWish(deps, wishId, 'Failed to initiate call');
    throw new AppError(502, 'vendor_error', 'Failed to initiate call');
  }
  await deps.db`update public.voice_call_wishes set vapi_call_id = ${call.id} where id = ${wishId} and vapi_call_id is null`;
  return { wishId };
}

/** Vapi's endedReason → the app's status vocabulary. */
export function vapiTerminal(reason: string | null | undefined): string {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('did-not-answer') || r.includes('no-answer')) return 'no-answer';
  if (r.includes('busy')) return 'busy';
  if (r.includes('voicemail')) return 'voicemail';
  if (r.includes('error') || r.includes('failed') || r.includes('fault') || r.startsWith('pipeline-')) return 'failed';
  return 'completed';
}

/**
 * One authenticated Vapi server message for a voice wish. Idempotent: statuses only move forward, and a repeated
 * end-of-call report rewrites the same values. Unknown calls are ignored.
 */
export async function applyVapiMessage(deps: Deps, message: Record<string, unknown>): Promise<'applied' | 'ignored'> {
  const type = typeof message.type === 'string' ? message.type : '';
  const call = (message.call && typeof message.call === 'object' ? message.call : {}) as Record<string, unknown>;
  const vapiId = typeof call.id === 'string' ? call.id : '';
  const meta = (call.metadata && typeof call.metadata === 'object' ? call.metadata : {}) as Record<string, unknown>;
  const byMeta = typeof meta.voiceCallWishId === 'string' && /^[0-9a-f-]{36}$/.test(meta.voiceCallWishId) ? meta.voiceCallWishId : null;
  if (!vapiId && !byMeta) return 'ignored';
  const rows = await deps.db<{ id: string; call_status: string | null }[]>`
    select id::text, call_status from public.voice_call_wishes
    where (${byMeta}::uuid is not null and id = ${byMeta}::uuid and (vapi_call_id is null or vapi_call_id = ${vapiId}))
       or (${vapiId} <> '' and vapi_call_id = ${vapiId})
    limit 1`;
  const w = rows[0];
  if (!w) return 'ignored';
  let status: string | null = null;
  let completed = false;
  let seconds: number | null = null;
  let reason: string | null = null;
  let transcript: string | null = null;
  if (type === 'status-update') {
    const s = String(message.status ?? '');
    status = s === 'ringing' ? 'ringing' : s === 'in-progress' || s === 'forwarding' ? 'in-progress' : s === 'ended' && (message.endedReason ?? call.endedReason) ? vapiTerminal(String(message.endedReason ?? call.endedReason)) : null;
  } else if (type === 'end-of-call-report') {
    reason = String(message.endedReason ?? call.endedReason ?? '').slice(0, 100) || null;
    status = vapiTerminal(reason);
    completed = status === 'completed';
    const d = Number(message.durationSeconds);
    seconds = Number.isFinite(d) && d >= 0 ? Math.round(d) : null;
    const artifact = (message.artifact && typeof message.artifact === 'object' ? message.artifact : {}) as Record<string, unknown>;
    const t = artifact.transcript ?? message.transcript;
    transcript = typeof t === 'string' ? t.slice(0, 20_000) : null;
  } else {
    return 'ignored';
  }
  if (!status) return 'applied';
  if (rankOf(w.call_status) >= rankOf(status)) return 'applied';
  await deps.db`
    update public.voice_call_wishes set call_status = ${status},
      vapi_call_id = coalesce(vapi_call_id, ${vapiId || null}),
      completed_at = case when ${completed} then coalesce(completed_at, now()) else completed_at end,
      call_duration_seconds = coalesce(${seconds}::int, call_duration_seconds),
      disconnect_reason = coalesce(${reason}, disconnect_reason),
      call_transcript = coalesce(${transcript}, call_transcript)
    where id = ${w.id} and coalesce(call_status, '') not in ('completed', 'no-answer', 'busy', 'voicemail', 'failed')`;
  return 'applied';
}
