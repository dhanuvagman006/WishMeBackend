/**
 * voice-token, web-search and the voice-call wish functions with every vendor stubbed: engine choice and token
 * minting, grounded search with caching and limits, server-side prices and ledger money (charge, refund), voice
 * ownership, private voice samples, and the signed Vapi webhook.
 */
import type { Job } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { callbackUrl } from '../../src/domains/voice/ai-calls.js';
import { module as calls } from '../../src/jobs/processors/calls.js';
import { anon, bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

/** Replaces a vendor client the app already memoised (routes create some at build time) with a fake's members. */
function patchMemo(ctx: TestCtx, key: string, fake: object): void {
  const inst = ctx.deps.memo(key, () => fake) as Record<string, unknown>;
  if (inst === fake) return;
  for (const [name, desc] of Object.entries(Object.getOwnPropertyDescriptors(fake))) {
    const value = typeof desc.value === 'function' ? (desc.value as (...a: unknown[]) => unknown).bind(fake) : desc.value;
    Object.defineProperty(inst, name, { value, configurable: true, writable: true });
  }
}

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;
let aliceProfile: string;
let bobProfile: string;
let celebId: string;
const realFetch = globalThis.fetch;
type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };
let seen: Seen[] = [];
let seq = 0;
const fail = new Set<string>();
const b2 = { configured: true, puts: [] as Array<{ key: string; isPrivate: boolean }>, async putBuffer(key: string, _b: Buffer, _t: string, isPrivate = false) { this.puts.push({ key, isPrivate }); }, async signedGetUrl(key: string) { return `https://signed.example/${key}?sig=1`; }, async remove() {} };
const eleven = { configured: true, async textToSpeech() { return Buffer.from('ID3-audio'); } };

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null;
    }
    seen.push({ url, method, headers, body });
    if (url.endsWith('/v1beta/auth_tokens')) return jsonRes(200, { name: 'auth_tokens/ephemeral-1' });
    if (url.includes(':generateContent')) {
      return jsonRes(200, { candidates: [{ content: { parts: [{ text: 'Mumbai gold (24k) is ₹7,950 per gram on 16 October 2026, per IBJA.' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://ibja.example', title: 'IBJA' } }] } }] });
    }
    if (url.startsWith('https://api.vobiz.ai/')) return fail.has('vobiz') ? jsonRes(500, { error: 'down' }) : jsonRes(201, { request_uuid: `vz-${++seq}` });
    if (url === 'https://api.vapi.ai/voice' && method === 'GET') {
      return jsonRes(200, [{ id: 'shared-ava', name: 'Ava', provider: '11labs' }, { id: 'clone-of-bob', name: 'Bob voice', provider: '11labs' }]);
    }
    if (url === 'https://api.vapi.ai/voice' && method === 'POST') return jsonRes(201, { id: `cloned-${++seq}` });
    if (url === 'https://api.vapi.ai/call') return fail.has('vapi') ? jsonRes(400, { message: 'bad number' }) : jsonRes(201, { id: `vapi-${++seq}`, status: 'queued' });
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

const post = (s: TestSession | null, fn: string, payload: unknown, extra: Record<string, string> = {}) =>
  t.app.inject({ method: 'POST', url: `/functions/v1/${fn}`, headers: { ...(s ? bearer(s.access_token) : anon()), 'content-type': 'application/json', ...extra }, payload: JSON.stringify(payload) });
const balance = async (profileId: string) => Number((await t.sql`select wallet_balance from public.profiles where id = ${profileId}`)[0]!.wallet_balance);

beforeAll(async () => {
  t = await bootTest({
    env: {
      GEMINI_API_KEY: 'test-gemini', SARVAM_API_KEY: 'test-sarvam', VAPI_API_KEY: 'test-vapi', VAPI_PHONE_NUMBER_ID: 'pn-1', VAPI_WEBHOOK_SECRET: 'vapi-secret-123',
      VOBIZ_AUTH_ID: 'MA_TEST', VOBIZ_AUTH_TOKEN: 'test-token', VOBIZ_PHONE_NUMBER: '+918000000000', WEB_SEARCH_PROVIDER: 'gemini',
    },
  });
  patchMemo(t, 'b2', b2);
  patchMemo(t, 'elevenlabs', eleven);
  alice = await signUp(t, 'voice-alice@example.com', undefined, { first_name: 'Alice', phone: '9123400301' });
  bob = await signUp(t, 'voice-bob@example.com', undefined, { first_name: 'Bob', phone: '9123400302' });
  aliceProfile = await profileIdOf(t, alice.user.id);
  bobProfile = await profileIdOf(t, bob.user.id);
  await t.sql`update public.profiles set wallet_balance = 2000 where id = ${aliceProfile}`;
  const [c] = await t.sql<{ id: string }[]>`
    insert into public.celebrities (name, category, vapi_voice_id, voice_call_price, is_active) values ('Star One', 'Actor', 'el-voice-star', 500, true) returning id::text`;
  celebId = c!.id;
  await t.sql`insert into public.user_vapi_voices (user_id, vapi_voice_id, voice_name) values (${bobProfile}, 'clone-of-bob', 'Bob voice')`;
});
beforeEach(() => {
  seen = [];
  fail.clear();
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await t.close();
});

describe('voice-token', () => {
  it('answers a probe without minting, and mints a single-use Live token on request', async () => {
    expect((await post(null, 'voice-token', { probe: true })).statusCode).toBe(401);
    const probe = await post(alice, 'voice-token', { probe: true, supports: ['gemini', 'sarvam'] });
    expect(probe.json()).toEqual({ engine: 'gemini', fallback_engine: 'sarvam', relay_url: 'ws://localhost:3000/functions/v1/sarvam-voice?apikey=test-anon-key' });
    expect(seen).toHaveLength(0);
    const mint = await post(alice, 'voice-token', { want: 'gemini', supports: ['gemini', 'sarvam'] });
    expect(mint.statusCode).toBe(200);
    expect(mint.json()).toMatchObject({ engine: 'gemini', token: 'auth_tokens/ephemeral-1', model: 'gemini-live-2.5-flash-preview', fallback_engine: 'sarvam' });
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/auth_tokens');
    expect(seen[0]!.headers['x-goog-api-key']).toBe('test-gemini');
    expect(seen[0]!.body).toMatchObject({ uses: 1 });
  });

  it("follows the admin's engine choice, and never hands an app an engine it does not support", async () => {
    await t.sql`insert into public.platform_settings (setting_key, setting_value) values ('ai_voice_engine', 'sarvam'), ('ai_voice_fallback', 'false')`;
    await t.deps.kv.del('voice:engine-settings');
    const sarvam = await post(alice, 'voice-token', { supports: ['gemini', 'sarvam'] });
    expect(sarvam.json()).toEqual({ engine: 'sarvam', relay_url: 'ws://localhost:3000/functions/v1/sarvam-voice?apikey=test-anon-key', fallback_engine: null });
    expect(seen).toHaveLength(0);
    const old = await post(alice, 'voice-token', {});
    expect(old.json()).toMatchObject({ engine: 'gemini', token: 'auth_tokens/ephemeral-1' });
    await t.sql`delete from public.platform_settings where setting_key in ('ai_voice_engine', 'ai_voice_fallback')`;
    await t.deps.kv.del('voice:engine-settings');
  });
});

describe('web-search', () => {
  it('answers a warm-up with 204 and a search with dated, sourced text, cached on repeat', async () => {
    const warm = await post(alice, 'web-search', { warm: true });
    expect(warm.statusCode).toBe(204);
    expect(seen).toHaveLength(0);
    const res = await post(alice, 'web-search', { queries: ['gold rate Mumbai 24 carat'], recency: 'day', depth: 'basic', query: 'gold rate Mumbai 24 carat', kind: 'news' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, provider: 'gemini', credits: 1, cached: false });
    expect(body.results).toContain('₹7,950');
    expect(body.results).toContain('Sources: IBJA');
    expect((seen[0]!.body as { tools: unknown[] }).tools).toEqual([{ google_search: {} }]);
    const again = await post(alice, 'web-search', { queries: ['Gold rate Mumbai 24 carat'], recency: 'day' });
    expect(again.json()).toMatchObject({ ok: true, cached: true, credits: 0 });
    expect(seen).toHaveLength(1);
  });

  it('limits searches per user with 429', async () => {
    let last = 0;
    for (let i = 0; i < 12 && last !== 429; i++) {
      last = (await post(bob, 'web-search', { queries: [`q${i} a`, `q${i} b`, `q${i} c`] })).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('vapi-celebrity-call', () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    recipientName: 'Ravi', recipientPhone: '+919812345678', occasion: 'Birthday', senderName: 'Alice', celebrityId: celebId, celebrityName: 'Star One',
    voiceId: 'client-sent-voice', price: 500, customMessage: 'Have a great year', tone: '', relationship: 'brother', language: 'english',
    thingsToAvoid: '', additionalContext: '', scheduledAt: null, ...extra,
  });

  it('requires a subscription and never charges more than the screen showed', async () => {
    const unsub = await post(alice, 'vapi-celebrity-call', body());
    expect(unsub.statusCode).toBe(403);
    expect(unsub.json()).toMatchObject({ subscriptionRequired: true });
    await t.sql`insert into public.celebrity_favorites (user_id, celebrity_id, price_paid) values (${aliceProfile}, ${celebId}, 100)`;
    const cheap = await post(alice, 'vapi-celebrity-call', body({ price: 1 }));
    expect(cheap.statusCode).toBe(409);
    expect(await balance(aliceProfile)).toBe(2000);
  });

  it('charges the server price through the ledger, stores the greeting privately and rings through Vobiz', async () => {
    const res = await post(alice, 'vapi-celebrity-call', body({ price: 999 }));
    expect(res.statusCode).toBe(200);
    const { success, callId, scheduled } = res.json();
    expect({ success, scheduled }).toEqual({ success: true, scheduled: false });
    expect(await balance(aliceProfile)).toBe(1500);
    const [w] = await t.sql`select * from public.voice_call_wishes where id = ${callId}`;
    expect(w).toMatchObject({ user_id: aliceProfile, price_paid: 500, call_status: 'initiated', vapi_voice_id: 'el-voice-star', vapi_call_id: `vz-${seq}`, recipient_phone: '+919812345678' });
    expect(b2.puts).toContainEqual({ key: `voice-call-wishes/${callId}.mp3`, isPrivate: true });
    const [tx] = await t.sql`select transaction_type, amount from public.wallet_transactions where user_id = ${aliceProfile} order by created_at desc limit 1`;
    expect(tx).toMatchObject({ transaction_type: 'voice_call', amount: 500 });

    // Vobiz plays the greeting through a signed link; only an answered call becomes 'completed'.
    await t.app.inject({ method: 'GET', url: callbackUrl(t.deps, 'wish', callId, 'ring').replace('http://localhost:3000', '') });
    const answer = await t.app.inject({ method: 'GET', url: callbackUrl(t.deps, 'wish', callId, 'answer').replace('http://localhost:3000', '') });
    expect(answer.body).toContain(`<Play>https://signed.example/voice-call-wishes/${callId}.mp3?sig=1</Play>`);
    const hang = new URL(callbackUrl(t.deps, 'wish', callId, 'hangup'));
    hang.searchParams.set('Duration', '37');
    await t.app.inject({ method: 'GET', url: `${hang.pathname}${hang.search}` });
    expect((await t.sql`select call_status, call_duration_seconds from public.voice_call_wishes where id = ${callId}`)[0]).toEqual({ call_status: 'completed', call_duration_seconds: 37 });
  });

  it('refunds through the ledger when the call cannot be placed', async () => {
    fail.add('vobiz');
    const res = await post(alice, 'vapi-celebrity-call', body());
    expect(res.statusCode).toBe(502);
    expect(await balance(aliceProfile)).toBe(1500);
    const [w] = await t.sql`select id::text, call_status from public.voice_call_wishes order by created_at desc limit 1`;
    expect(w!.call_status).toBe('failed');
    expect((await t.sql`select 1 from wishme.ledger_entries where idempotency_key = ${`voice_call_wish:${w!.id}:refund`}`).length).toBe(1);
  });

  it('books a scheduled call, charged now and dialled by the worker at the time', async () => {
    const at = new Date(Date.now() + 2 * 3600_000).toISOString();
    const res = await post(alice, 'vapi-celebrity-call', body({ scheduledAt: at }));
    expect(res.json()).toMatchObject({ success: true, scheduled: true, scheduledAt: at });
    expect(await balance(aliceProfile)).toBe(1000);
    const id = res.json().callId as string;
    const job = t.jobs.enqueued.find((j) => j.opts?.jobId === `voice-call-wish:${id}`)!;
    expect(job.name).toBe('start-voice-call-wish');
    const handle = calls.processors.find((p) => p.name === 'start-voice-call-wish')!.handle;
    await handle({ data: job.data } as Job, t.deps);
    await handle({ data: job.data } as Job, t.deps);
    expect(seen.filter((s) => s.url.startsWith('https://api.vobiz.ai/'))).toHaveLength(1);
  });
});

describe('voice-call wishes through Vapi', () => {
  it("lists shared voices plus the caller's own clones, never someone else's", async () => {
    const a = (await post(alice, 'vapi-get-voices', {})).json();
    expect(a.vapiVoices.map((v: { id: string }) => v.id)).toEqual(['shared-ava']);
    expect(a.userVoices).toEqual([]);
    const b = (await post(bob, 'vapi-get-voices', {})).json();
    expect(b.userVoices).toMatchObject([{ vapi_voice_id: 'clone-of-bob', voice_name: 'Bob voice' }]);
  });

  it('places a wish only in an allowed voice, charging ₹100 and refunding a failed call', async () => {
    const req = { recipientName: 'Meera', recipientPhone: '+919811122233', occasion: 'Anniversary', voiceId: 'clone-of-bob', voiceName: 'Bob voice', voiceProvider: '11labs', language: 'hindi' };
    const stolen = await post(alice, 'vapi-make-call', req);
    expect(stolen.statusCode).toBe(400);
    const before = await balance(aliceProfile);
    const ok = await post(alice, 'vapi-make-call', { ...req, voiceId: 'shared-ava', voiceName: 'Ava' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ success: true, message: 'Call initiated to Meera!' });
    expect(await balance(aliceProfile)).toBe(before - 100);
    const vapiCall = seen.find((s) => s.url === 'https://api.vapi.ai/call')!;
    expect(vapiCall.headers.authorization).toBe('Bearer test-vapi');
    expect(vapiCall.body).toMatchObject({ phoneNumberId: 'pn-1', customer: { number: '+919811122233' }, assistant: { voice: { voiceId: 'shared-ava', language: 'hi' }, server: { headers: { 'x-vapi-secret': 'vapi-secret-123' } } } });
    fail.add('vapi');
    const broken = await post(alice, 'vapi-make-call', { ...req, voiceId: 'shared-ava' });
    expect(broken.statusCode).toBe(502);
    expect(await balance(aliceProfile)).toBe(before - 100);
  });

  it('clones an uploaded sample from private storage', async () => {
    const notAudio = await post(alice, 'vapi-upload-voice', { voiceName: 'Mine', audioBase64: Buffer.from('x'.repeat(200)).toString('base64') });
    expect(notAudio.statusCode).toBe(400);
    const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300)]).toString('base64');
    const res = await post(alice, 'vapi-upload-voice', { voiceName: 'My voice', audioBase64: audio });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, voiceName: 'My voice' });
    const upload = b2.puts[b2.puts.length - 1]!;
    expect(upload).toMatchObject({ isPrivate: true });
    expect(upload.key).toMatch(new RegExp(`^vapi-voices/${aliceProfile}/\\d+\\.mp3$`));
    const create = seen.find((s) => s.url === 'https://api.vapi.ai/voice' && s.method === 'POST')!;
    expect(create.body).toMatchObject({ provider: '11labs', name: 'My voice', files: [`https://signed.example/${upload.key}?sig=1`] });
    const [row] = await t.sql`select vapi_voice_id, audio_url from public.user_vapi_voices where user_id = ${aliceProfile}`;
    expect(row).toEqual({ vapi_voice_id: res.json().voiceId, audio_url: upload.key });
  });
});

describe('vapi-webhook', () => {
  const hook = (payload: unknown, secret?: string) =>
    t.app.inject({ method: 'POST', url: '/functions/v1/vapi-webhook?apikey=test-anon-key', headers: { 'content-type': 'application/json', ...(secret ? { 'x-vapi-secret': secret } : {}) }, payload: JSON.stringify(payload) });

  it('refuses unsigned events and applies signed ones forward-only and idempotently', async () => {
    const [w] = await t.sql<{ id: string }[]>`
      insert into public.voice_call_wishes (user_id, recipient_name, recipient_phone, occasion, vapi_voice_id, vapi_call_id, call_status, price_paid)
      values (${aliceProfile}, 'Meera', '+919811122233', 'Anniversary', 'shared-ava', 'vapi-hook-1', 'initiated', 100) returning id::text`;
    const call = { id: 'vapi-hook-1' };
    expect((await hook({ message: { type: 'status-update', status: 'ringing', call } })).statusCode).toBe(401);
    expect((await hook({ message: { type: 'status-update', status: 'ringing', call } }, 'wrong')).statusCode).toBe(401);
    expect((await hook({ message: { type: 'status-update', status: 'ringing', call } }, 'vapi-secret-123')).json()).toEqual({ ok: true });
    const report = { message: { type: 'end-of-call-report', endedReason: 'customer-ended-call', durationSeconds: 33.4, call, artifact: { transcript: 'AI: Happy anniversary!\nUser: Thank you' } } };
    await hook(report, 'vapi-secret-123');
    await hook(report, 'vapi-secret-123');
    await hook({ message: { type: 'status-update', status: 'in-progress', call } }, 'vapi-secret-123');
    const [row] = await t.sql`select call_status, call_duration_seconds, disconnect_reason, call_transcript, webhook_payload from public.voice_call_wishes where id = ${w!.id}`;
    expect(row).toMatchObject({ call_status: 'completed', call_duration_seconds: 33, disconnect_reason: 'customer-ended-call', webhook_payload: null });
    expect(row!.call_transcript).toContain('Happy anniversary');
    const unknown = await hook({ message: { type: 'status-update', status: 'ringing', call: { id: 'not-ours' } } }, 'vapi-secret-123');
    expect(unknown.json()).toEqual({ ok: true, ignored: true });
  });
});
