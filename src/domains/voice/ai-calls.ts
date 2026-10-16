/**
 * AI phone calls the assistant makes for a user (ai-call-start) and reminder calls (the reminder dispatcher). Both
 * ring through Vobiz and are written to public.ai_calls (owner = auth user id), which the app polls
 * (services/assistant/aiCalls.ts createAiCallWatcher). The live conversation runs in ./vobiz-call.ts.
 *
 * Facts from the production schema and functions (supabase audit 2026-10-16): ai_calls columns (vapi_call_id holds
 * whichever phone service's call id; started_at, ended_at, opted_out, price_paid, recording_seconds,
 * recording_expires_at, updated_at), platform_settings keys ai_call_enabled, ai_call_price (whole rupees, charged only
 * when a call connected), ai_call_record, ai_call_recording_days, and the same-number guard (2 calls a minute).
 *
 * Changes from production, on purpose:
 *  - the charge goes through the ledger (idempotent, balance-checked) instead of a client-style balance update;
 *  - a call is dialled at most once: placement claims the row first (vapi_call_id = 'pending:<id>');
 *  - status only moves forward, so a late or repeated callback cannot undo a result;
 *  - a daily cap per user (setting ai_call_daily_limit, default 25); production had none;
 *  - scheduling (scheduleAt) is supported through the calls queue; production refused it.
 */
import type { Deps } from '../../deps.js';
import { hmacSha256Hex, safeEqual } from '../../lib/crypto.js';
import type { Queryable } from '../../lib/db.js';
import { isAppError } from '../../lib/errors.js';
import { QUEUES } from '../../jobs/queues.js';
import { Gemini } from '../../vendors/gemini.js';
import { Vobiz } from '../../vendors/vobiz.js';
import { InsufficientFunds } from '../wallet/ledger.js';
import { markMirrorable } from '../wallet/mirrors.js';
import { CALL_SUMMARY_PROMPT, OUTCOMES, transcriptToText, type CallLine } from './call-prompt.js';

export type AiCallStatus = 'queued' | 'scheduled' | 'ringing' | 'in-progress' | 'completed' | 'no-answer' | 'busy' | 'voicemail' | 'failed';

export const TERMINAL: readonly string[] = ['completed', 'no-answer', 'busy', 'voicemail', 'failed'];
export const isTerminal = (s: string | null | undefined) => TERMINAL.includes(s ?? '');
const RANK: Record<string, number> = { scheduled: 0, queued: 0, pending: 0, initiated: 0, ringing: 1, 'in-progress': 2 };
export const rankOf = (s: string | null | undefined) => (isTerminal(s) ? 3 : (RANK[s ?? ''] ?? 0));

/** Seconds Vobiz lets a call run (production: a little above our own wind-up). */
export const CALL_TIME_LIMIT = { task: 420, reminder: 180 } as const;

export const vobizOf = (deps: Deps): Vobiz => deps.memo('vobiz', () => new Vobiz(deps.env, deps.log));
export const geminiOf = (deps: Deps): Gemini => deps.memo('gemini', () => new Gemini(deps.env, deps.log));

export const cleanText = (s: unknown, max: number): string =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Names go into prompts: plain text only. */
export const cleanName = (s: unknown): string => cleanText(typeof s === 'string' ? s.replace(/["'`<>{}\\]/g, '') : '', 60);

export function normaliseLanguage(lang: unknown): 'english' | 'hindi' | 'hinglish' {
  const l = typeof lang === 'string' ? lang.toLowerCase().trim() : '';
  return l === 'hindi' || l === 'hinglish' ? l : 'english';
}

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** platform_settings values are text (production schema). */
export async function settings(q: Queryable, keys: readonly string[]): Promise<Map<string, string>> {
  const rows = await q<{ setting_key: string; setting_value: unknown }[]>`
    select setting_key, setting_value from public.platform_settings where setting_key = any(${keys as string[]}::text[])`;
  const out = new Map<string, string>();
  for (const r of rows) {
    const v = r.setting_value;
    out.set(r.setting_key, typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return out;
}

/** A whole-rupee price setting (0 when unset or invalid: AI calls are free unless the admin sets a price). */
export function rupees(v: string | undefined): number {
  const n = Number(v ?? '0');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ── Vobiz callback URLs ──────────────────────────────────────────────────────────────────────────────────────────

export type CallKind = 'ai' | 'wish';

/** Vobiz cannot log in, so every URL it calls carries a token bound to this call (HMAC with a server secret). */
export function callToken(deps: Deps, kind: CallKind, id: string): string {
  return hmacSha256Hex(deps.env.AUTH_PEPPER, `vobiz-call:${kind}:${id}`).slice(0, 40);
}

export function parseCallKey(deps: Deps, k: string | null): { kind: CallKind; id: string } | null {
  const m = /^(ai|wish)\.([0-9a-f-]{36})\.([0-9a-f]{40})$/.exec(k ?? '');
  if (!m) return null;
  const kind = m[1] as CallKind;
  return safeEqual(m[3]!, callToken(deps, kind, m[2]!)) ? { kind, id: m[2]! } : null;
}

function callbackBase(deps: Deps, fn: 'vobiz-call' | 'vobiz-stream', scheme: 'http' | 'ws'): URL {
  const url = new URL(`/functions/v1/${fn}`, deps.env.PUBLIC_URL);
  if (scheme === 'ws') url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // The compat gateway checks an apikey on every function request; the anon key is public (it ships in the app).
  if (deps.env.SUPABASE_ANON_KEY) url.searchParams.set('apikey', deps.env.SUPABASE_ANON_KEY);
  return url;
}

export function callbackUrl(deps: Deps, kind: CallKind, id: string, action: 'ring' | 'answer' | 'hangup' | 'recording'): string {
  const url = callbackBase(deps, 'vobiz-call', 'http');
  url.searchParams.set('a', action);
  url.searchParams.set('k', `${kind}.${id}.${callToken(deps, kind, id)}`);
  return url.toString();
}

export function streamUrl(deps: Deps, id: string): string {
  const url = callbackBase(deps, 'vobiz-stream', 'ws');
  url.searchParams.set('k', `ai.${id}.${callToken(deps, 'ai', id)}`);
  return url.toString();
}

// ── creating and placing ─────────────────────────────────────────────────────────────────────────────────────────

export interface AiCallInput {
  userId: string;
  toName: string | null;
  toPhone: string;
  purpose: string;
  details: string | null;
  language: 'english' | 'hindi' | 'hinglish';
  scheduledFor: Date | null;
}

export async function insertAiCall(q: Queryable, input: AiCallInput): Promise<string> {
  const rows = await q<{ id: string }[]>`
    insert into public.ai_calls (user_id, to_name, to_phone, purpose, details, language, status, scheduled_for)
    values (${input.userId}, ${input.toName}, ${input.toPhone}, ${input.purpose}, ${input.details}, ${input.language},
            ${input.scheduledFor ? 'scheduled' : 'queued'}, ${input.scheduledFor ? input.scheduledFor.toISOString() : null})
    returning id::text`;
  return rows[0]!.id;
}

export const DIAL_FAILED = 'The phone service could not place the call. Please try again in a moment.';

/** Marks a call failed, unless it already has a result. */
export async function failAiCall(q: Queryable, callId: string, message: string, endedReason = 'dial-failed'): Promise<void> {
  await q`
    update public.ai_calls set status = 'failed', error_message = ${message.slice(0, 300)},
      ended_reason = coalesce(ended_reason, ${endedReason}), ended_at = coalesce(ended_at, now()), updated_at = now()
    where id = ${callId} and status not in ('completed', 'no-answer', 'busy', 'voicemail', 'failed')`;
}

/**
 * Dials an ai_calls row through Vobiz. `placed: false` means the phone service refused and the row is now failed.
 * A row that an earlier attempt already claimed is left alone, so a retried job never rings anyone twice.
 */
export async function placeAiCall(deps: Deps, callId: string, kind: 'task' | 'reminder'): Promise<{ placed: boolean; alreadyClaimed?: boolean; error?: string }> {
  const rows = await deps.db<{ id: string; to_phone: string }[]>`
    update public.ai_calls set vapi_call_id = ${`pending:${callId}`}, status = 'queued', updated_at = now()
    where id = ${callId} and vapi_call_id is null and status in ('queued', 'scheduled')
    returning id::text, to_phone`;
  const row = rows[0];
  if (!row) return { placed: true, alreadyClaimed: true };
  let placed: { id: string };
  try {
    placed = await vobizOf(deps).placeCall({
      to: row.to_phone,
      answerUrl: callbackUrl(deps, 'ai', callId, 'answer'),
      ringUrl: callbackUrl(deps, 'ai', callId, 'ring'),
      hangupUrl: callbackUrl(deps, 'ai', callId, 'hangup'),
      timeLimitSeconds: CALL_TIME_LIMIT[kind],
    });
  } catch (e) {
    deps.log.warn({ callId, err: (e as Error).message }, 'ai call could not be placed');
    await failAiCall(deps.db, callId, DIAL_FAILED);
    return { placed: false, error: DIAL_FAILED };
  }
  // The phone is ringing now: a failure to note the provider's id must not mark the call failed.
  await deps.db`update public.ai_calls set vapi_call_id = ${placed.id}, updated_at = now() where id = ${callId} and vapi_call_id = ${`pending:${callId}`}`.catch(
    (e: unknown) => deps.log.error({ callId, err: (e as Error).message }, 'could not record the phone service call id'),
  );
  return { placed: true };
}

/** Moves a call forward to `status` (never backwards; a finished call stays finished). */
export async function advanceAiCall(q: Queryable, callId: string, status: 'ringing' | 'in-progress'): Promise<boolean> {
  const allowed = status === 'ringing' ? ['queued', 'scheduled'] : ['queued', 'scheduled', 'ringing'];
  const rows = await q`
    update public.ai_calls set status = ${status}, updated_at = now(),
      started_at = case when ${status} = 'in-progress' then coalesce(started_at, now()) else started_at end
    where id = ${callId} and status = any(${allowed}::text[]) returning id`;
  return rows.length > 0;
}

// ── finishing ────────────────────────────────────────────────────────────────────────────────────────────────────

async function summarise(deps: Deps, lines: readonly CallLine[], answered: boolean): Promise<string> {
  if (!answered) return 'Nobody answered the call.';
  if (!lines.some((l) => l.role === 'user')) return 'The call connected but the other person did not say anything.';
  const gemini = geminiOf(deps);
  if (gemini.configured) {
    try {
      const { text } = await gemini.text({ prompt: `${CALL_SUMMARY_PROMPT}\n\nCALL TRANSCRIPT:\n${transcriptToText(lines).slice(0, 20_000)}`, temperature: 0.2, maxTokens: 400, timeoutMs: 20_000 });
      if (text) return text.slice(0, 2000);
    } catch {
      /* fall through to the plain summary */
    }
  }
  return `The call was answered. They said: ${lines.filter((l) => l.role === 'user').map((l) => l.message).join(' ')}`.slice(0, 600);
}

export interface FinishInput {
  answered: boolean;
  /** busy, customer-did-not-answer, customer-ended-call, assistant-ended-call, exceeded-max-duration, engine-error-… */
  reason: string;
  lines: CallLine[];
  outcome?: { outcome?: unknown; next_step?: unknown; opted_out?: unknown } | null;
}

/**
 * Writes the result of a call once: status, transcript, summary, outcome; charges for a call that connected; marks a
 * linked reminder missed (nobody answered) or acknowledged (they heard it). Safe to call twice.
 */
export async function finishAiCall(deps: Deps, callId: string, f: FinishInput): Promise<void> {
  const current = await deps.db<{ status: string }[]>`select status from public.ai_calls where id = ${callId}`;
  if (!current[0] || isTerminal(current[0].status)) return;
  const transcript = f.lines.length ? transcriptToText(f.lines) : null;
  // The transcript is the one thing that cannot be rebuilt: save it before the slow summary.
  if (transcript) await deps.db`update public.ai_calls set transcript = ${transcript}, updated_at = now() where id = ${callId}`;
  const status: AiCallStatus = !f.answered ? (f.reason === 'busy' ? 'busy' : f.reason === 'failed' ? 'failed' : 'no-answer') : f.reason.startsWith('engine-error') ? 'failed' : 'completed';
  const summary = await summarise(deps, f.lines, f.answered);
  const heard = f.lines.some((l) => l.role === 'user');
  const o = f.outcome ?? { outcome: f.answered && heard ? 'partial' : 'no_info' };
  const outcome = typeof o.outcome === 'string' && OUTCOMES.has(o.outcome) ? o.outcome : null;
  const nextStep = typeof o.next_step === 'string' ? o.next_step.slice(0, 400) : null;

  const done = await deps.db<{ user_id: string; started_at: string | null }[]>`
    update public.ai_calls set status = ${status}, ended_reason = ${f.reason.slice(0, 100)}, ended_at = now(),
      duration_seconds = case when started_at is null then 0 else greatest(0, round(extract(epoch from now() - started_at)))::int end,
      transcript = coalesce(${transcript}, transcript), summary = ${summary},
      outcome = coalesce(${outcome}, outcome), next_step = coalesce(${nextStep}, next_step),
      opted_out = opted_out or ${o.opted_out === true},
      error_message = case when ${status} = 'failed' then 'The call could not be completed.' else error_message end,
      updated_at = now()
    where id = ${callId} and status not in ('completed', 'no-answer', 'busy', 'voicemail', 'failed')
    returning user_id::text, started_at::text`;
  const row = done[0];
  if (!row) return; // another finisher won the race
  deps.log.info({ callId, status, reason: f.reason }, 'ai call finished');

  if (status === 'completed') await chargeAiCall(deps, callId, row.user_id);
  // A reminder call: heard → acknowledged (no escalation); not reached → missed.
  if (status === 'completed') {
    await deps.db`update public.reminders set acknowledged_at = coalesce(acknowledged_at, now()), updated_at = now() where call_id = ${callId}`;
  } else {
    await deps.db`update public.reminders set status = 'missed', updated_at = now() where call_id = ${callId} and status = 'pending'`;
  }
}

/** Charges ai_call_price (whole rupees) for a call that connected, once, through the ledger. */
export async function chargeAiCall(deps: Deps, callId: string, userId: string): Promise<void> {
  const price = rupees((await settings(deps.db, ['ai_call_price'])).get('ai_call_price'));
  if (price <= 0) return;
  const profile = await deps.db<{ id: string }[]>`select id from public.profiles where user_id = ${userId} limit 1`;
  if (!profile[0]) return;
  try {
    await deps.db.begin(async (tx) => {
      await deps.ledger.apply(tx, 'user_wallet', {
        accountId: profile[0]!.id,
        deltaPaise: -price * 100,
        kind: 'ai_call',
        idempotencyKey: `ai_call:${callId}:charge`,
        createdBy: userId,
        description: 'AI call on your behalf',
        paymentMethod: 'wallet',
        details: markMirrorable({ service_type: 'ai_call', order_id: callId }),
        reference: { type: 'ai_call', id: callId },
      });
      await tx`update public.ai_calls set price_paid = ${price}, updated_at = now() where id = ${callId}`;
    });
  } catch (e) {
    // The call already happened; a wallet that ran dry since the start is logged, not forced negative.
    if (e instanceof InsufficientFunds || (isAppError(e) && e.code === 'insufficient_balance')) {
      deps.log.warn({ callId }, 'ai call not charged: insufficient balance');
      return;
    }
    throw e;
  }
}

// ── recordings ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Hosts a recording may be fetched from. ASSUMPTION: Vobiz serves recordings from its own domains or S3. */
export function allowedRecordingSource(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'vobiz.ai' || h.endsWith('.vobiz.ai') || h.endsWith('.amazonaws.com') || h === 'storage.googleapis.com';
  } catch {
    return false;
  }
}

export async function enqueueRecording(deps: Deps, callId: string, source: string, seconds: number): Promise<void> {
  if (!allowedRecordingSource(source)) {
    deps.log.warn({ callId }, 'recording callback with an unexpected source host ignored');
    return;
  }
  await deps.jobs.enqueue(QUEUES.calls, 'store-recording', { callId, source, seconds }, { jobId: `recording:${callId}` });
}
