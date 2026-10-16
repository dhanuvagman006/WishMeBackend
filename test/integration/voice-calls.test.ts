/**
 * AI calls end to end with the phone service stubbed: ai-call-start (number rules, confirmation, guards, scheduling),
 * the Vobiz callbacks (per-call token, forward-only status, answer XML, hangup), finishing and charging through the
 * ledger, recordings (404 / 410 / signed link), the reminder dispatcher and the stuck-call sweep.
 */
import type { Job } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { callbackUrl } from '../../src/domains/voice/ai-calls.js';
import { module as calls } from '../../src/jobs/processors/calls.js';
import { module as reminders } from '../../src/jobs/processors/reminders.js';
import { bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;
/** Replaces a vendor client the app already memoised (routes create some at build time) with a fake's members. */
function patchMemo(ctx: TestCtx, key: string, fake: object): void {
  const inst = ctx.deps.memo(key, () => fake) as Record<string, unknown>;
  if (inst === fake) return;
  for (const name of Object.getOwnPropertyNames(fake)) Object.defineProperty(inst, name, { value: (fake as Record<string, unknown>)[name], configurable: true, writable: true });
  for (const [name, desc] of Object.entries(Object.getOwnPropertyDescriptors(fake))) {
    if (typeof desc.value === 'function') Object.defineProperty(inst, name, { value: (desc.value as (...a: unknown[]) => unknown).bind(fake), configurable: true, writable: true });
  }
}
const realFetch = globalThis.fetch;
let vobizCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
let vobizFails = false;
let vobizSeq = 0;
const b2 = { configured: true, puts: [] as string[], removed: [] as string[], async putBuffer(key: string) { this.puts.push(key); }, async signedGetUrl(key: string) { return `https://signed.example/${key}?sig=1`; }, async remove(key: string) { this.removed.push(key); } };

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.vobiz.ai/')) {
      vobizCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      if (vobizFails) return new Response(JSON.stringify({ error: 'nope' }), { status: 400, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ request_uuid: `vz-${++vobizSeq}` }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://recordings.vobiz.ai/')) return new Response(Buffer.from('ID3fakeaudio'), { status: 200 });
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

const start = (s: TestSession, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url: '/functions/v1/ai-call-start', headers: { ...bearer(s.access_token), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
const callback = (url: string) => t.app.inject({ method: 'GET', url: url.replace('http://localhost:3000', '') });
const run = (mod: typeof calls, name: string, data: Record<string, unknown>) => mod.processors.find((p) => p.name === name)!.handle({ data } as Job, t.deps);
const call = async (id: string) => (await t.sql`select * from public.ai_calls where id = ${id}`)[0]!;

beforeAll(async () => {
  t = await bootTest({ env: { VOBIZ_AUTH_ID: 'MA_TEST', VOBIZ_AUTH_TOKEN: 'test-token', VOBIZ_PHONE_NUMBER: '+918000000000' } });
  alice = await signUp(t, 'calls-alice@example.com', undefined, { first_name: 'Alice', phone: '9000000201' });
  bob = await signUp(t, 'calls-bob@example.com', undefined, { first_name: 'Bob', phone: '9000000202' });
  patchMemo(t, 'b2', b2);
  await t.sql`update public.profiles set wallet_balance = 100, phone = '9123400201' where user_id = ${alice.user.id}`;
  await t.sql`insert into public.platform_settings (setting_key, setting_value) values ('ai_call_price', '10')`;
});
beforeEach(async () => {
  for (const u of [alice, bob]) await t.deps.kv.del(`rl:fn:ai-call-start:u:${u.user.id}`);
  vobizCalls = [];
  vobizFails = false;
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await t.close();
});

describe('ai-call-start', () => {
  it('needs the spoken confirmation and refuses numbers the platform must never dial', async () => {
    const unconfirmed = await start(alice, { phone: '+919812345678', purpose: 'Ask about the order' });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json()).toMatchObject({ needsConfirmation: true });
    for (const phone of ['112', '1800 123 4567', '+14155550100', '140 123 4567', '12345']) {
      const res = await start(alice, { phone, purpose: 'Ask about the order', confirmed: true });
      expect(res.statusCode, phone).toBe(400);
      expect(res.json().error).toBeTruthy();
    }
    expect((await start(alice, { phone: '+919812345678', purpose: 'hi', confirmed: true })).json().error).toMatch(/what the call is for/);
    expect(vobizCalls).toHaveLength(0);
  });

  it('records the call and rings through Vobiz with per-call callback URLs', async () => {
    const res = await start(alice, { name: 'Ravi', phone: '098123 45678', purpose: 'Ask if the parcel was delivered', language: 'hindi', confirmed: true });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, status: 'queued', scheduledFor: null, to: { phone: '+919812345678' }, price: 10 });
    expect(vobizCalls).toHaveLength(1);
    expect(vobizCalls[0]!.url).toBe('https://api.vobiz.ai/api/v1/Account/MA_TEST/Call/');
    expect(vobizCalls[0]!.body).toMatchObject({ from: '918000000000', to: '919812345678', answer_method: 'GET', time_limit: '420' });
    expect(String(vobizCalls[0]!.body.answer_url)).toMatch(new RegExp(`a=answer&k=ai\\.${body.callId}\\.[0-9a-f]{40}`));
    expect(await call(body.callId)).toMatchObject({ user_id: alice.user.id, status: 'queued', vapi_call_id: `vz-${vobizSeq}`, language: 'hindi', to_name: 'Ravi' });
  });

  it('guards the person being called: twice a minute at most, never after they opted out', async () => {
    const again = await start(alice, { phone: '+919812345678', purpose: 'Ask if the parcel was delivered', confirmed: true });
    expect(again.statusCode).toBe(200);
    const third = await start(alice, { phone: '+919812345678', purpose: 'Ask if the parcel was delivered', confirmed: true });
    expect(third.statusCode).toBe(429);
    await t.sql`insert into public.ai_calls (user_id, to_phone, purpose, status, opted_out) values (${bob.user.id}, '+919811111111', 'Earlier call here', 'completed', true)`;
    const optedOut = await start(alice, { phone: '+919811111111', purpose: 'Ask if the parcel was delivered', confirmed: true });
    expect(optedOut.statusCode).toBe(403);
  });

  it('refuses a call the wallet cannot pay for, and fails cleanly when the phone service refuses', async () => {
    const broke = await start(bob, { phone: '+919822222222', purpose: 'Confirm the appointment', confirmed: true });
    expect(broke.statusCode).toBe(402);
    vobizFails = true;
    const res = await start(alice, { phone: '+919833333333', purpose: 'Confirm the appointment', confirmed: true });
    expect(res.statusCode).toBe(502);
    const [row] = await t.sql`select status, error_message from public.ai_calls where to_phone = '+919833333333'`;
    expect(row).toMatchObject({ status: 'failed' });
  });

  it('books a call for later on the calls queue', async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const res = await start(alice, { phone: '+919844444444', purpose: 'Wish them happy birthday', scheduleAt: at, confirmed: true });
    expect(res.statusCode).toBe(200);
    const { callId, status, scheduledFor } = res.json();
    expect(status).toBe('scheduled');
    expect(Date.parse(scheduledFor)).toBe(Date.parse(at));
    expect(vobizCalls).toHaveLength(0);
    const job = t.jobs.enqueued.find((j) => j.opts?.jobId === `ai-call:${callId}`);
    expect(job).toMatchObject({ queue: 'calls', name: 'start-scheduled-call' });
    await run(calls, 'start-scheduled-call', { callId });
    await run(calls, 'start-scheduled-call', { callId });
    expect(vobizCalls).toHaveLength(1);
    expect((await call(callId)).status).toBe('queued');
  });
});

describe('Vobiz callbacks and the result', () => {
  let callId: string;

  beforeAll(async () => {
    const [row] = await t.sql<{ id: string }[]>`
      insert into public.ai_calls (user_id, to_phone, purpose, status, vapi_call_id) values (${alice.user.id}, '+919855555555', 'Ask for the bill amount', 'queued', 'vz-cb') returning id::text`;
    callId = row!.id;
  });

  it('rejects a forged token and moves the status only forward', async () => {
    const forged = await t.app.inject({ method: 'GET', url: `/functions/v1/vobiz-call?apikey=test-anon-key&a=ring&k=ai.${callId}.${'0'.repeat(40)}` });
    expect(forged.statusCode).toBe(404);
    expect((await callback(callbackUrl(t.deps, 'ai', callId, 'ring'))).statusCode).toBe(200);
    expect((await call(callId)).status).toBe('ringing');
    const answer = await callback(callbackUrl(t.deps, 'ai', callId, 'answer'));
    expect(answer.headers['content-type']).toMatch(/text\/xml/);
    expect(answer.body).toContain('<Stream bidirectional="true"');
    expect(answer.body).toContain('ws://localhost:3000/functions/v1/vobiz-stream?apikey=test-anon-key&amp;k=ai.');
    expect(answer.body).toContain('<Record recordSession="true"');
    expect((await call(callId)).status).toBe('in-progress');
    await callback(callbackUrl(t.deps, 'ai', callId, 'ring'));
    expect((await call(callId)).status).toBe('in-progress');
  });

  it('closes an answered call whose stream never reported, charging once through the ledger', async () => {
    await t.sql`insert into public.ai_call_lines (call_id, role, message, seq) values (${callId}, 'assistant', 'Hello, I am an AI assistant', 0), (${callId}, 'user', 'The bill is 400', 1)`;
    const hangup = await callback(callbackUrl(t.deps, 'ai', callId, 'hangup'));
    expect(hangup.statusCode).toBe(200);
    expect(t.jobs.enqueued.find((j) => j.opts?.jobId === `ai-call:${callId}:hangup`)).toMatchObject({ name: 'finish-stale-call' });
    const before = Number((await t.sql`select wallet_balance from public.profiles where user_id = ${alice.user.id}`)[0]!.wallet_balance);
    await run(calls, 'finish-stale-call', { callId });
    await run(calls, 'finish-stale-call', { callId });
    const row = await call(callId);
    expect(row).toMatchObject({ status: 'completed', ended_reason: 'customer-ended-call', transcript: 'AI: Hello, I am an AI assistant\nThem: The bill is 400', outcome: 'partial' });
    expect(Number(row.price_paid)).toBe(10);
    const after = Number((await t.sql`select wallet_balance from public.profiles where user_id = ${alice.user.id}`)[0]!.wallet_balance);
    expect(before - after).toBe(10);
    expect((await t.sql`select 1 from wishme.ledger_entries where idempotency_key = ${`ai_call:${callId}:charge`}`).length).toBe(1);
  });

  it('writes an unanswered call as no-answer without charging, and keeps recordings private', async () => {
    const [row] = await t.sql<{ id: string }[]>`insert into public.ai_calls (user_id, to_phone, purpose, status) values (${alice.user.id}, '+919866666666', 'Ask for the bill amount', 'ringing') returning id::text`;
    const url = new URL(callbackUrl(t.deps, 'ai', row!.id, 'hangup'));
    url.searchParams.set('CallStatus', 'busy');
    await callback(url.toString());
    expect(await call(row!.id)).toMatchObject({ status: 'busy', summary: 'Nobody answered the call.' });
    expect(Number((await call(row!.id)).price_paid)).toBe(0);

    const rec = new URL(callbackUrl(t.deps, 'ai', callId, 'recording'));
    rec.searchParams.set('RecordUrl', 'https://evil.example/steal');
    await callback(rec.toString());
    expect(t.jobs.enqueued.some((j) => j.opts?.jobId === `recording:${callId}`)).toBe(false);
    rec.searchParams.set('RecordUrl', 'https://recordings.vobiz.ai/r/1.mp3');
    rec.searchParams.set('RecordingDuration', '42');
    await callback(rec.toString());
    const job = t.jobs.enqueued.find((j) => j.opts?.jobId === `recording:${callId}`)!;
    await run(calls, 'store-recording', job.data);
    expect(b2.puts).toContain(`ai-calls/${callId}.mp3`);
    expect(await call(callId)).toMatchObject({ recording_url: `ai-calls/${callId}.mp3`, recording_seconds: 42 });
  });

  it('hands the owner a short-lived link, 404 without a recording, 410 once deleted', async () => {
    const rec = (s: TestSession, id: string) =>
      t.app.inject({ method: 'POST', url: '/functions/v1/ai-call-recording', headers: { ...bearer(s.access_token), 'content-type': 'application/json' }, payload: JSON.stringify({ callId: id }) });
    const ok = await rec(alice, callId);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ url: `https://signed.example/ai-calls/${callId}.mp3?sig=1`, expiresInSeconds: 900 });
    expect((await rec(bob, callId)).statusCode).toBe(404);
    const [none] = await t.sql<{ id: string }[]>`insert into public.ai_calls (user_id, to_phone, purpose, status) values (${alice.user.id}, '+919877777777', 'No recording here', 'completed') returning id::text`;
    expect((await rec(alice, none!.id)).statusCode).toBe(404);
    await t.sql`update public.ai_calls set recording_expires_at = now() - interval '1 day' where id = ${callId}`;
    await run(calls, 'expire-recordings', {});
    expect(b2.removed).toContain(`ai-calls/${callId}.mp3`);
    const gone = await rec(alice, callId);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error).toMatch(/deleted/);
  });
});

describe('reminder dispatcher', () => {
  it('rings call reminders once, pushes the others, rolls repeats forward and escalates unacknowledged ones', async () => {
    const uid = alice.user.id;
    const [callR] = await t.sql<{ id: string }[]>`
      insert into public.reminders (user_id, title, due_at, delivery) values (${uid}, 'Take medicine', now() - interval '1 minute', 'call') returning id::text`;
    const [pushR] = await t.sql<{ id: string }[]>`
      insert into public.reminders (user_id, title, due_at, delivery, recurrence, escalate, escalate_after_minutes)
      values (${uid}, 'Water plants', now() - interval '2 minutes', 'notification', 'daily', false, 3) returning id::text`;
    const [escR] = await t.sql<{ id: string }[]>`
      insert into public.reminders (user_id, title, due_at, delivery, escalate, escalate_after_minutes, fired_at)
      values (${uid}, 'Call the bank', now() - interval '10 minutes', 'notification', true, 3, now() - interval '5 minutes') returning id::text`;
    const [lateR] = await t.sql<{ id: string }[]>`
      insert into public.reminders (user_id, title, due_at, delivery) values (${uid}, 'Ancient', now() - interval '7 hours', 'call') returning id::text`;

    const first = await run(reminders, 'dispatch-due', {});
    const second = await run(reminders, 'dispatch-due', {});
    expect(first).toMatchObject({ delivered: 2, escalated: 1, missed: 1 });
    expect(second).toMatchObject({ delivered: 0, escalated: 0 });

    const r1 = (await t.sql`select call_id::text, fired_at from public.reminders where id = ${callR!.id}`)[0]!;
    expect(r1.call_id).toBeTruthy();
    expect(await call(r1.call_id)).toMatchObject({ user_id: uid, to_phone: '+919123400201', purpose: 'Reminder: Take medicine', status: 'queued' });
    const callJobs = t.jobs.enqueued.filter((j) => j.name === 'reminder-call');
    expect(callJobs).toHaveLength(2);
    const push = t.jobs.enqueued.find((j) => j.queue === 'notifications' && j.name === 'push');
    expect(push?.data).toMatchObject({ userId: uid, title: 'Water plants', data: { kind: 'reminder', reminderId: pushR!.id } });
    const series = await t.sql`select status, due_at from public.reminders where title = 'Water plants' order by due_at`;
    expect(series.map((r) => r.status)).toEqual(['done', 'pending']);
    expect((await t.sql`select call_id from public.reminders where id = ${escR!.id}`)[0]!.call_id).toBeTruthy();
    expect((await t.sql`select status from public.reminders where id = ${lateR!.id}`)[0]!.status).toBe('missed');

    // The job dials it; a repeat of the job does not ring again.
    const job = callJobs.find((j) => j.data.reminderId === callR!.id)!;
    await run(reminders, 'reminder-call', job.data);
    await run(reminders, 'reminder-call', job.data);
    expect(vobizCalls).toHaveLength(1);
    expect(vobizCalls[0]!.body).toMatchObject({ time_limit: '180' });
    // Nobody picked up: the reminder is missed.
    const url = new URL(callbackUrl(t.deps, 'ai', r1.call_id as string, 'hangup'));
    await callback(url.toString());
    expect((await t.sql`select status from public.reminders where id = ${callR!.id}`)[0]!.status).toBe('missed');
  });

  it('respects the admin switch', async () => {
    await t.sql`insert into public.platform_settings (setting_key, setting_value) values ('reminders_enabled', 'false')`;
    await t.sql`insert into public.reminders (user_id, title, due_at, delivery) values (${alice.user.id}, 'Switched off', now(), 'notification')`;
    expect(await run(reminders, 'dispatch-due', {})).toEqual({ delivered: 0, escalated: 0, missed: 0 });
    await t.sql`delete from public.platform_settings where setting_key = 'reminders_enabled'`;
  });
});

describe('stuck-call sweep', () => {
  it('fails calls that never started and re-queues scheduled ones whose job was lost', async () => {
    const [stuck] = await t.sql<{ id: string }[]>`
      insert into public.ai_calls (user_id, to_phone, purpose, status, vapi_call_id, updated_at)
      values (${alice.user.id}, '+919888888888', 'Stuck call here', 'queued', ${'pending:x'}, now() - interval '20 minutes') returning id::text`;
    const [late] = await t.sql<{ id: string }[]>`
      insert into public.ai_calls (user_id, to_phone, purpose, status, scheduled_for)
      values (${alice.user.id}, '+919899999999', 'Late scheduled call', 'scheduled', now() - interval '5 minutes') returning id::text`;
    const out = await run(calls, 'sweep-stuck-calls', {});
    expect(out).toMatchObject({ failed: 1, restarted: 1 });
    expect((await call(stuck!.id)).status).toBe('failed');
    expect(t.jobs.enqueued.find((j) => j.opts?.jobId === `ai-call:${late!.id}:sweep`)).toBeTruthy();
    void profileIdOf;
  });
});
