/**
 * Edge-function replacements for the voice assistant, AI calls and voice-call wishes. See ../registry.ts for the
 * conventions. Request and response shapes follow the production functions (supabase audit 2026-10-16) and the
 * app's callers (docs/reference/BACKEND_CONTRACT_INVENTORY.md, Domain 5); security holes found there are closed:
 * signed webhooks, server-side prices, ledger money movements, server-side number checks, owner-only recordings.
 *
 *   voice-token          engine choice + Gemini Live ephemeral token
 *   sarvam-voice         WebSocket relay to Sarvam (domains/voice/sarvam-relay.ts)
 *   ai-call-start        the assistant phones someone (Vobiz)
 *   ai-call-recording    short-lived link to the owner's recording (404 none, 410 deleted)
 *   web-search           the assistant's research
 *   vapi-celebrity-call  a call in a celebrity's voice (priced server-side, Vobiz)
 *   vapi-get-voices      shared voices + the caller's own clones
 *   vapi-upload-voice    clone a voice from an uploaded sample
 *   vapi-make-call       a voice-call wish in a chosen voice (Vapi)
 *   vapi-webhook         Vapi call events (x-vapi-secret)
 *   vobiz-call           Vobiz callbacks (ring / answer / hangup / recording), per-call HMAC
 *   vobiz-stream         Vobiz two-way media stream for AI calls (WebSocket)
 */
import { z } from 'zod';
import type { Deps } from '../../../deps.js';
import {
  insertAiCall,
  normaliseLanguage,
  placeAiCall,
  rupees,
  settings,
  vobizOf,
  cleanName,
  cleanText,
} from '../../../domains/voice/ai-calls.js';
import { checkIndianNumber } from '../../../domains/voice/phone.js';
import { RelaySession, sarvamOf } from '../../../domains/voice/sarvam-relay.js';
import { handleVobizCallback, runCallStream, geminiLiveOf } from '../../../domains/voice/vobiz-call.js';
import { applyVapiMessage, b2Of, bookCelebrityCall, dispatchCelebrityCall, placeVoiceWish, vapiOf, voicesFor } from '../../../domains/voice/voice-wishes.js';
import { NOTHING, OFFLINE, SEARCH_LIMITS, normaliseQueries, research, type Recency } from '../../../domains/voice/web-search.js';
import { QUEUES } from '../../../jobs/queues.js';
import { safeEqual } from '../../../lib/crypto.js';
import { AppError, isAppError, unavailable } from '../../../lib/errors.js';
import { defineFunctions, parseBody, type FnContext, type FnResult } from '../registry.js';
import { geminiOf } from '../../../domains/voice/ai-calls.js';

const json = (status: number, body: unknown): FnResult => ({ status, body });

async function profileOf(c: FnContext): Promise<string> {
  const id = (await c.identity()).profileId;
  if (!id) throw new AppError(404, 'not_found', 'Profile not found.');
  return id;
}

/** The relay URL the app connects to: wss:// form of PUBLIC_URL, with the public anon key the gateway asks for. */
export function relayUrl(deps: Deps): string {
  const url = new URL('/functions/v1/sarvam-voice', deps.env.PUBLIC_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (deps.env.SUPABASE_ANON_KEY) url.searchParams.set('apikey', deps.env.SUPABASE_ANON_KEY);
  return url.toString();
}

/** platform_settings ai_voice_engine / ai_voice_fallback, cached for a minute (production did the same per worker). */
async function engineSettings(deps: Deps): Promise<{ wanted: 'gemini' | 'sarvam'; fallbackOn: boolean }> {
  const key = 'voice:engine-settings';
  const hit = await deps.kv.get(key);
  if (hit) return JSON.parse(hit) as { wanted: 'gemini' | 'sarvam'; fallbackOn: boolean };
  const s = await settings(deps.db, ['ai_voice_engine', 'ai_voice_fallback']);
  const out = { wanted: s.get('ai_voice_engine') === 'sarvam' ? ('sarvam' as const) : ('gemini' as const), fallbackOn: s.get('ai_voice_fallback') !== 'false' };
  await deps.kv.set(key, JSON.stringify(out), 60);
  return out;
}

const voiceTokenBody = z
  .object({ probe: z.boolean().optional(), want: z.enum(['gemini', 'sarvam']).optional(), supports: z.array(z.string().max(20)).max(5).optional() })
  .passthrough();

const aiCallBody = z.object({
  name: z.string().max(120).nullish(),
  phone: z.union([z.string().max(40), z.number()]),
  purpose: z.string().max(2000).default(''),
  details: z.string().max(4000).nullish(),
  language: z.string().max(20).nullish(),
  scheduleAt: z.string().max(40).nullish(),
  confirmed: z.unknown().optional(),
});

const celebrityCallBody = z.object({
  recipientName: z.string().trim().min(1).max(80),
  recipientPhone: z.string().max(40),
  occasion: z.string().trim().min(1).max(80),
  senderName: z.string().trim().min(1).max(80),
  celebrityId: z.string().uuid(),
  celebrityName: z.string().max(120).optional(),
  voiceId: z.string().max(120).optional(),
  price: z.number().nonnegative().max(1_000_000).nullish(),
  celebrityPhoneId: z.string().max(120).nullish(),
  customMessage: z.string().max(500).default(''),
  tone: z.string().max(60).default(''),
  relationship: z.string().max(60).default(''),
  language: z.string().max(20).default('english'),
  thingsToAvoid: z.string().max(500).default(''),
  additionalContext: z.string().max(1000).default(''),
  scheduledAt: z.string().max(40).nullish(),
});

const makeCallBody = z.object({
  recipientName: z.string().trim().min(1).max(80),
  recipientPhone: z.string().max(40),
  occasion: z.string().trim().min(1).max(80),
  voiceId: z.string().trim().min(1).max(120),
  voiceName: z.string().max(120).default(''),
  voiceProvider: z.string().max(40).optional(),
  language: z.string().max(20).default('english'),
});

const uploadVoiceBody = z.object({
  voiceName: z.string().trim().min(1).max(60),
  // ~10 MB of audio as base64 (the screen refuses larger files).
  audioBase64: z.string().min(100).max(14_000_000),
  provider: z.string().max(40).optional(),
});

/** Recognisable audio containers only (the sample is sent to the cloning service). */
function sniffAudio(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (buf.toString('ascii', 4, 8) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' };
  if (buf.toString('ascii', 0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (buf.toString('ascii', 0, 4) === 'fLaC') return { ext: 'flac', mime: 'audio/flac' };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: 'webm', mime: 'audio/webm' };
  return null;
}

/** An ISO time at least a minute ahead and within `maxDays`, else null (= now). Throws on garbage. */
function futureTime(raw: string | null | undefined, maxDays: number): Date | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new AppError(400, 'invalid_request', 'That time is not valid.');
  if (t - Date.now() < 60_000) return null;
  if (t - Date.now() > maxDays * 86_400_000) throw new AppError(400, 'invalid_request', `Calls can be booked at most ${maxDays} days ahead.`);
  return new Date(t);
}

export const functions = defineFunctions([
  {
    name: 'voice-token',
    access: 'user',
    rateLimit: { limit: 60, windowSec: 60, by: 'user' },
    handler: async (c) => {
      const body = parseBody(voiceTokenBody, c.body);
      const supports = body.supports ?? ['gemini'];
      const live = geminiLiveOf(c.deps);
      const sarvam = sarvamOf(c.deps);
      const { wanted, fallbackOn } = await engineSettings(c.deps);
      const canUse = (e: 'gemini' | 'sarvam') => supports.includes(e) && (e === 'sarvam' ? sarvam.configured : live.configured);
      const engine = canUse(wanted) ? wanted : canUse('gemini') ? 'gemini' : canUse('sarvam') ? 'sarvam' : null;
      if (!engine) throw unavailable('Voice assistant is not configured');
      const other = engine === 'sarvam' ? 'gemini' : 'sarvam';
      const fallback = fallbackOn && canUse(other) ? other : null;
      const relay = relayUrl(c.deps);
      if (body.probe === true) return { body: { engine, fallback_engine: fallback, relay_url: relay } };
      if (engine === 'sarvam' && !(body.want === 'gemini' && live.configured)) return { body: { engine, relay_url: relay, fallback_engine: fallback } };
      // Every reconnect mints a token: generous, but bounded (each token can open a paid Live session).
      await c.deps.limiter.hit('voice-token-mint', `u:${c.auth.userId}`, { limit: 40, windowSec: 600 }, 'Too many voice sessions. Please wait a little.');
      const t = await live.mint({ ttlSec: 30 * 60, startWithinSec: 60 });
      return { body: { engine, token: t.token, model: t.model, fallback_engine: fallback, relay_url: relay } };
    },
  },
  {
    name: 'sarvam-voice',
    // The app's WebSocket carries no token; the user logs in with the first frame (see sarvam-relay.ts).
    access: 'anon',
    handler: async () => ({ status: 426, body: { error: 'Expected a WebSocket connection' } }),
    websocket: (socket, c) => {
      new RelaySession(socket, c.deps, c.auth, c.deps.log.child({ requestId: c.requestId, fn: 'sarvam-voice' }));
    },
  },
  {
    name: 'ai-call-start',
    access: 'user',
    rateLimit: { limit: 10, windowSec: 60, by: 'user' },
    handler: async (c) => {
      const deps = c.deps;
      const body = parseBody(aiCallBody, c.body);
      if (body.confirmed !== true) return json(400, { error: 'The user must confirm the call first.', needsConfirmation: true });
      if (!vobizOf(deps).configured) return json(503, { error: 'AI calling is not set up yet.' });
      const s = await settings(deps.db, ['ai_call_enabled', 'ai_call_price', 'ai_call_daily_limit']);
      if (s.get('ai_call_enabled') === 'false') return json(403, { error: 'AI calls are switched off right now.' });
      const number = checkIndianNumber(body.phone);
      if (!number.ok) return json(400, { error: number.reason });
      const purpose = cleanText(body.purpose, 600);
      if (purpose.length < 5) return json(400, { error: 'Please say what the call is for.' });
      const details = cleanText(body.details ?? '', 800) || null;
      const toName = cleanName(body.name ?? '') || null;
      const language = normaliseLanguage(body.language);
      const scheduledFor = futureTime(body.scheduleAt, 30);
      const userId = c.auth.userId!;

      const prior = await deps.db<{ opted_out: boolean; recent: boolean }[]>`
        select opted_out, created_at > now() - interval '60 seconds' as recent
        from public.ai_calls where to_phone = ${number.e164} order by created_at desc limit 20`;
      if (prior.some((p) => p.opted_out)) return json(403, { error: "That person asked not to receive these calls, so the assistant can't call them." });
      if (prior.filter((p) => p.recent).length >= 2) return json(429, { error: 'That number was called moments ago. Please wait a minute before trying again.' });
      const limit = Math.max(1, Math.floor(Number(s.get('ai_call_daily_limit') ?? '25')) || 25);
      const today = await deps.db<{ n: number }[]>`select count(*)::int as n from public.ai_calls where user_id = ${userId} and created_at > now() - interval '1 day' and purpose not like 'Reminder:%'`;
      if ((today[0]?.n ?? 0) >= limit) return json(429, { error: "You've reached today's limit for AI calls. Please try again tomorrow." });
      const price = rupees(s.get('ai_call_price'));
      const profile = await deps.db<{ balance: number }[]>`select coalesce(wallet_balance, 0)::float8 as balance from public.profiles where user_id = ${userId} limit 1`;
      if (!profile[0]) return json(404, { error: 'Profile not found.' });
      if (price > 0 && profile[0].balance < price) return json(402, { error: `An AI call costs ₹${price}. Please add money to your wallet first.` });

      const callId = await insertAiCall(deps.db, { userId, toName, toPhone: number.e164, purpose, details, language, scheduledFor });
      const to = { name: toName, phone: number.e164, spoken: `${number.national.slice(0, 5)} ${number.national.slice(5)}` };
      if (scheduledFor) {
        await deps.jobs.enqueue(QUEUES.calls, 'start-scheduled-call', { callId }, { jobId: `ai-call:${callId}`, delay: scheduledFor.getTime() - Date.now() });
        return { body: { ok: true, callId, status: 'scheduled', to, scheduledFor: scheduledFor.toISOString(), price } };
      }
      const placed = await placeAiCall(deps, callId, 'task');
      if (!placed.placed) return json(502, { error: placed.error });
      return { body: { ok: true, callId, status: 'queued', to, scheduledFor: null, price } };
    },
  },
  {
    name: 'ai-call-recording',
    access: 'user',
    methods: ['GET', 'POST'],
    rateLimit: { limit: 30, windowSec: 60, by: 'user' },
    handler: async (c) => {
      const body = (c.body && typeof c.body === 'object' ? c.body : {}) as { callId?: unknown };
      const callId = String(body.callId ?? c.query.get('callId') ?? '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) return json(400, { error: 'callId is required' });
      const rows = await c.deps.db<{ recording_url: string | null; expired: boolean }[]>`
        select recording_url, coalesce(recording_expires_at < now(), false) as expired
        from public.ai_calls where id = ${callId} and user_id = ${c.auth.userId!}`;
      const call = rows[0];
      if (!call) return json(404, { error: 'Call not found' });
      if (!call.recording_url) return json(404, { error: 'There is no recording for this call.' });
      if (call.expired || call.recording_url.startsWith('expired:')) {
        return json(410, { error: 'That recording has been deleted. The written conversation is still there.' });
      }
      const expiresInSeconds = 900;
      if (/^https:\/\//i.test(call.recording_url)) return { body: { url: call.recording_url, expiresInSeconds } };
      const url = await b2Of(c.deps).signedGetUrl(call.recording_url, { isPrivate: true, expiresSec: expiresInSeconds });
      return { body: { url, expiresInSeconds } };
    },
  },
  {
    name: 'web-search',
    access: 'user',
    handler: async (c) => {
      const body = (c.body && typeof c.body === 'object' ? c.body : {}) as Record<string, unknown>;
      // A warm-up only boots the function: nothing checked, nothing counted.
      if (body.warm === true) return { status: 204 };
      if (c.deps.env.WEB_SEARCH_PROVIDER === 'none' || !geminiOf(c.deps).configured) {
        return json(503, { ok: false, error: 'Web search is not configured.', instruction: OFFLINE });
      }
      const queries = normaliseQueries(body);
      if (!queries.length) return json(400, { ok: false, error: 'No search query was given.' });
      const recency: Recency = ['any', 'day', 'week', 'month'].includes(String(body.recency)) ? (body.recency as Recency) : body.kind === 'news' ? 'week' : 'any';
      try {
        for (let i = 0; i < queries.length; i++) {
          await c.deps.limiter.hit('web-search:min', `u:${c.auth.userId}`, SEARCH_LIMITS.perMinute);
          await c.deps.limiter.hit('web-search:day', `u:${c.auth.userId}`, SEARCH_LIMITS.perDay);
        }
      } catch (e) {
        if (isAppError(e) && e.status === 429) {
          return {
            status: 429,
            headers: e.headers ?? {},
            body: { ok: false, error: 'Too many searches. Try again in a minute.', instruction: 'Tell the user you have searched a lot just now and answer from what you know and what you already found.' },
          };
        }
        throw e;
      }
      const started = Date.now();
      const answer = await research(c.deps, queries, recency);
      const took = Date.now() - started;
      if (!answer) return { body: { ok: false, error: 'No results found.', instruction: OFFLINE, took_ms: took } };
      return {
        body: { ok: true, results: answer.text, provider: 'gemini', credits: answer.credits, cached: answer.cached, took_ms: took, ...(answer.nothing ? { instruction: NOTHING } : {}) },
      };
    },
  },
  {
    name: 'vapi-celebrity-call',
    access: 'user',
    rateLimit: { limit: 5, windowSec: 60, by: 'user' },
    handler: async (c) => {
      const r = celebrityCallBody.safeParse(c.body ?? {});
      if (!r.success) return json(400, { error: 'Missing required fields. Please fill in all call details.' });
      const b = r.data;
      const number = checkIndianNumber(b.recipientPhone);
      if (!number.ok) return json(400, { error: 'Please enter a valid 10-digit Indian mobile number.' });
      if (!vobizOf(c.deps).configured) return json(503, { error: 'Celebrity calls are not available right now.' });
      const profileId = await profileOf(c);
      const scheduledAt = futureTime(b.scheduledAt, 60);
      try {
        const booked = await bookCelebrityCall(c.deps, {
          userId: c.auth.userId!,
          profileId,
          celebrityId: b.celebrityId,
          recipientName: cleanName(b.recipientName) || 'Friend',
          recipientPhone: number.e164,
          occasion: cleanText(b.occasion, 80),
          senderName: cleanName(b.senderName) || 'A friend',
          clientPrice: b.price ?? null,
          config: {
            customMessage: cleanText(b.customMessage, 500),
            tone: cleanText(b.tone, 60),
            relationship: cleanText(b.relationship, 60),
            language: cleanText(b.language, 20).toLowerCase() || 'english',
            thingsToAvoid: cleanText(b.thingsToAvoid, 500),
            additionalContext: cleanText(b.additionalContext, 1000),
          },
          scheduledAt,
        });
        if (booked.scheduled) {
          return { body: { success: true, scheduled: true, callId: booked.wishId, scheduledAt: scheduledAt!.toISOString(), message: `Call scheduled for ${b.recipientName}` } };
        }
        const placed = await dispatchCelebrityCall(c.deps, booked.wishId);
        if (!placed.placed) return json(502, { error: placed.error });
        return { body: { success: true, scheduled: false, callId: booked.wishId, wishId: booked.wishId, message: `${booked.celebrityName} is now calling ${b.recipientName}!` } };
      } catch (e) {
        if (isAppError(e) && e.code === 'subscription_required') return json(403, { error: e.message, subscriptionRequired: true });
        throw e;
      }
    },
  },
  {
    name: 'vapi-get-voices',
    access: 'user',
    rateLimit: { limit: 30, windowSec: 60, by: 'user' },
    handler: async (c) => {
      if (!vapiOf(c.deps).configured) return json(503, { error: 'Voice calls are not available right now.' });
      const profileId = await profileOf(c);
      return { body: await voicesFor(c.deps, profileId) };
    },
  },
  {
    name: 'vapi-upload-voice',
    access: 'user',
    bodyLimit: 16 * 1024 * 1024,
    rateLimit: { limit: 5, windowSec: 3600, by: 'user' },
    handler: async (c) => {
      const deps = c.deps;
      const b = parseBody(uploadVoiceBody, c.body);
      const vapi = vapiOf(deps);
      const b2 = b2Of(deps);
      if (!vapi.configured || !b2.configured) return json(503, { error: 'Voice uploads are not available right now.' });
      const profileId = await profileOf(c);
      const count = await deps.db<{ n: number }[]>`select count(*)::int as n from public.user_vapi_voices where user_id = ${profileId}`;
      if ((count[0]?.n ?? 0) >= 20) return json(400, { error: 'You can keep up to 20 custom voices.' });
      const audio = Buffer.from(b.audioBase64, 'base64');
      if (audio.length > 10 * 1024 * 1024) return json(400, { error: 'Please upload an audio file under 10MB' });
      const kind = sniffAudio(audio);
      if (!kind) return json(400, { error: 'That file does not look like audio.' });
      // The voice sample is personal: stored privately (production made it public), lent to Vapi through a short link.
      const key = `vapi-voices/${profileId}/${Date.now()}.${kind.ext}`;
      await b2.putBuffer(key, audio, kind.mime, true);
      const fileUrl = await b2.signedGetUrl(key, { isPrivate: true, expiresSec: 3600 });
      const name = cleanName(b.voiceName) || 'My voice';
      const voice = await vapi.createVoice({ provider: '11labs', name, fileUrl });
      await deps.db`insert into public.user_vapi_voices (user_id, vapi_voice_id, voice_name, audio_url) values (${profileId}, ${voice.id}, ${name}, ${key})`;
      return { body: { success: true, voiceId: voice.id, voiceName: name } };
    },
  },
  {
    name: 'vapi-make-call',
    access: 'user',
    rateLimit: { limit: 5, windowSec: 60, by: 'user' },
    handler: async (c) => {
      const r = makeCallBody.safeParse(c.body ?? {});
      if (!r.success) return json(400, { error: 'Missing required fields' });
      const b = r.data;
      const number = checkIndianNumber(b.recipientPhone);
      if (!number.ok) return json(400, { error: 'Please enter a valid 10-digit Indian mobile number.' });
      const profileId = await profileOf(c);
      const placed = await placeVoiceWish(c.deps, {
        userId: c.auth.userId!,
        profileId,
        recipientName: cleanName(b.recipientName) || 'Friend',
        recipientPhone: number.e164,
        occasion: cleanText(b.occasion, 80),
        voiceId: b.voiceId,
        voiceName: cleanText(b.voiceName, 120),
        language: cleanText(b.language, 20).toLowerCase() || 'english',
      });
      return { body: { success: true, callId: placed.wishId, message: `Call initiated to ${b.recipientName}!` } };
    },
  },
  {
    name: 'vapi-webhook',
    access: 'anon',
    bodyLimit: 4 * 1024 * 1024,
    rateLimit: { limit: 1200, windowSec: 60, by: 'ip' },
    handler: async (c) => {
      const secret = c.deps.env.VAPI_WEBHOOK_SECRET;
      if (!secret) return json(503, { error: 'Webhook not configured' });
      const sent = c.headers['x-vapi-secret'];
      if (typeof sent !== 'string' || !safeEqual(sent, secret)) return json(401, { error: 'Unauthorized' });
      const payload = (c.body && typeof c.body === 'object' ? c.body : {}) as Record<string, unknown>;
      const message = (payload.message && typeof payload.message === 'object' ? payload.message : payload) as Record<string, unknown>;
      const result = await applyVapiMessage(c.deps, message);
      return { body: { ok: true, ...(result === 'ignored' ? { ignored: true } : {}) } };
    },
  },
  {
    name: 'vobiz-call',
    // Vobiz cannot log in: every URL carries a per-call HMAC (k=…), checked before anything is read.
    access: 'anon',
    methods: ['GET'],
    rateLimit: { limit: 1200, windowSec: 60, by: 'ip' },
    handler: (c) => handleVobizCallback(c.deps, c.query),
  },
  {
    name: 'vobiz-stream',
    access: 'anon',
    handler: async () => ({ status: 426, body: { error: 'Expected a WebSocket connection' } }),
    websocket: (socket, c) => runCallStream(c.deps, socket, c.query.get('k'), c.deps.log.child({ requestId: c.requestId, fn: 'vobiz-stream' })),
  },
]);
