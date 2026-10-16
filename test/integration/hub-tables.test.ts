/**
 * Hub tables through /rest/v1 exactly as the app calls them (services/hub/*.ts, AssistantPersonaContext.tsx,
 * services/assistant/aiCalls.ts): owner-only rows keyed on the auth user id, forced owners, server-owned fields
 * refused, the persona upsert, the recurrence-aware calendar read and read-only AI call logs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, bootTest, signUp, type TestCtx, type TestSession } from '../helpers.js';

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;

beforeAll(async () => {
  t = await bootTest();
  alice = await signUp(t, 'hub-alice@example.com', undefined, { first_name: 'Alice', phone: '9000000101' });
  bob = await signUp(t, 'hub-bob@example.com', undefined, { first_name: 'Bob', phone: '9000000102' });
});
afterAll(async () => {
  await t.close();
});

const get = (s: TestSession, url: string) => t.app.inject({ method: 'GET', url, headers: bearer(s.access_token) });
const send = (s: TestSession, method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, prefer?: string) =>
  t.app.inject({ method, url, headers: { ...bearer(s.access_token), 'content-type': 'application/json', ...(prefer ? { prefer } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });

describe('assistant_settings', () => {
  it('starts empty ("needs setup"), upserts on user_id and returns the row to its owner only', async () => {
    const empty = await get(alice, `/rest/v1/assistant_settings?select=*&user_id=eq.${alice.user.id}&limit=1`);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);
    const row = { user_id: bob.user.id, assistant_name: 'Jarvis', voice: 'Puck', personality: 'calm', custom_note: null, language: 'hindi', is_default: false, updated_at: new Date().toISOString() };
    const save = await send(alice, 'POST', '/rest/v1/assistant_settings?on_conflict=user_id', row, 'resolution=merge-duplicates,return=minimal');
    expect(save.statusCode).toBe(201);
    // Saved under the token's user, whatever user_id the body named.
    const mine = await get(alice, `/rest/v1/assistant_settings?select=*&user_id=eq.${alice.user.id}&limit=1`);
    expect(mine.json()).toMatchObject([{ user_id: alice.user.id, assistant_name: 'Jarvis', voice: 'Puck', language: 'hindi' }]);
    expect((await get(bob, `/rest/v1/assistant_settings?select=*&user_id=eq.${alice.user.id}`)).json()).toEqual([]);
    const again = await send(alice, 'POST', '/rest/v1/assistant_settings?on_conflict=user_id', { ...row, assistant_name: 'Friday' }, 'resolution=merge-duplicates,return=minimal');
    expect(again.statusCode).toBe(201);
    expect((await get(alice, '/rest/v1/assistant_settings?select=assistant_name')).json()).toEqual([{ assistant_name: 'Friday' }]);
  });

  it('rejects an invalid persona with a readable message', async () => {
    const res = await send(alice, 'POST', '/rest/v1/assistant_settings?on_conflict=user_id', { assistant_name: 'x'.repeat(31), voice: 'Kore', personality: 'calm', language: 'auto', is_default: false }, 'resolution=merge-duplicates');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/too long/);
  });
});

describe('calendar_events', () => {
  const COLUMNS = 'id,title,notes,location,starts_at,ends_at,all_day,timezone,recurrence,recurrence_until,colour,source,source_id,created_at,updated_at';
  let eventId: string;

  it('creates with the forced owner and source, returning the representation', async () => {
    const res = await send(alice, 'POST', '/rest/v1/calendar_events', [
      { title: 'Standup', notes: null, location: null, starts_at: '2026-01-05T04:30:00.000Z', ends_at: '2026-01-05T05:00:00.000Z', all_day: false, recurrence: 'daily', recurrence_until: null, user_id: bob.user.id, timezone: 'Asia/Kolkata' },
    ], 'return=representation');
    expect(res.statusCode).toBe(201);
    const [row] = res.json();
    expect(row).toMatchObject({ title: 'Standup', source: 'user', recurrence: 'daily', user_id: alice.user.id });
    eventId = row.id;
    await send(alice, 'POST', '/rest/v1/calendar_events', [{ title: 'Dentist', starts_at: '2026-11-20T06:00:00.000Z', ends_at: null, all_day: false, recurrence: 'none', recurrence_until: null, timezone: 'Asia/Kolkata' }]);
    await send(alice, 'POST', '/rest/v1/calendar_events', [{ title: 'Old one-off', starts_at: '2025-01-01T06:00:00.000Z', all_day: false, recurrence: 'none', timezone: 'Asia/Kolkata' }]);
  });

  it('reads a window the way the app does: in-window events plus every repeating one', async () => {
    const from = '2026-11-01T00:00:00.000Z';
    const to = '2026-11-30T23:59:59.000Z';
    const res = await get(alice, `/rest/v1/calendar_events?select=${COLUMNS}&starts_at=lte.${to}&or=(starts_at.gte.${from},recurrence.neq.none)&order=starts_at.asc`);
    expect(res.statusCode).toBe(200);
    expect(res.json().map((e: { title: string }) => e.title)).toEqual(['Standup', 'Dentist']);
    expect((await get(bob, `/rest/v1/calendar_events?select=id`)).json()).toEqual([]);
  });

  it('lets only the owner update or delete, and never edits mirrored events', async () => {
    const theirs = await send(bob, 'PATCH', `/rest/v1/calendar_events?id=eq.${eventId}`, { title: 'Hijacked', updated_at: new Date().toISOString() }, 'return=minimal');
    expect(theirs.statusCode).toBe(204);
    const ok = await send(alice, 'PATCH', `/rest/v1/calendar_events?id=eq.${eventId}`, { title: 'Daily standup', updated_at: new Date().toISOString() }, 'return=minimal');
    expect(ok.statusCode).toBe(204);
    expect((await get(alice, `/rest/v1/calendar_events?select=title&id=eq.${eventId}`)).json()).toEqual([{ title: 'Daily standup' }]);
    const mirrored = await t.sql<{ id: string }[]>`
      insert into public.calendar_events (user_id, title, starts_at, source) values (${alice.user.id}, 'Mom birthday', now(), 'occasion') returning id::text`;
    await send(alice, 'PATCH', `/rest/v1/calendar_events?id=eq.${mirrored[0]!.id}`, { title: 'Changed' });
    expect((await t.sql`select title from public.calendar_events where id = ${mirrored[0]!.id}`)[0]!.title).toBe('Mom birthday');
    const forged = await send(alice, 'PATCH', `/rest/v1/calendar_events?id=eq.${eventId}`, { source: 'booking' });
    expect(forged.statusCode).toBe(403);
    expect((await send(bob, 'DELETE', `/rest/v1/calendar_events?id=eq.${eventId}`)).statusCode).toBe(204);
    expect((await t.sql`select 1 from public.calendar_events where id = ${eventId}`).length).toBe(1);
  });

  it('refuses an event that ends before it starts', async () => {
    const res = await send(alice, 'POST', '/rest/v1/calendar_events', [{ title: 'Backwards', starts_at: '2026-11-20T06:00:00Z', ends_at: '2026-11-20T05:00:00Z', all_day: false, recurrence: 'none', timezone: 'Asia/Kolkata' }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/cannot end before/);
  });
});

describe('reminders', () => {
  const COLUMNS =
    'id,title,notes,due_at,timezone,pin_to_timezone,lead_minutes,delivery,style,recurrence,recurrence_until,escalate,escalate_after_minutes,escalate_phone,status,completed_at,event_id,call_id,created_at,updated_at';
  const draft = {
    title: 'Pay rent', notes: null, due_at: '2026-12-01T04:30:00.000Z', pin_to_timezone: false, lead_minutes: 0, delivery: 'call', style: 'alarm',
    recurrence: 'none', recurrence_until: null, escalate: true, escalate_after_minutes: 3, escalate_phone: '98765 43210',
  };
  let id: string;

  it('creates a reminder for the token user with a normalised escalation number', async () => {
    const res = await send(alice, 'POST', '/rest/v1/reminders', [{ ...draft, user_id: bob.user.id, timezone: 'Asia/Kolkata' }], 'return=representation');
    expect(res.statusCode).toBe(201);
    const [row] = res.json();
    expect(row).toMatchObject({ title: 'Pay rent', status: 'pending', user_id: alice.user.id, escalate_phone: '+919876543210', call_id: null });
    id = row.id;
  });

  it('refuses emergency numbers, server-owned fields and the missed status', async () => {
    const sos = await send(alice, 'POST', '/rest/v1/reminders', [{ ...draft, escalate_phone: '112' }]);
    expect(sos.statusCode).toBe(400);
    expect(sos.json().message).toMatch(/emergency/);
    const call = await send(alice, 'PATCH', `/rest/v1/reminders?id=eq.${id}`, { call_id: '00000000-0000-0000-0000-000000000000' });
    expect(call.statusCode).toBe(403);
    const fired = await send(alice, 'PATCH', `/rest/v1/reminders?id=eq.${id}`, { fired_at: new Date().toISOString() });
    expect(fired.statusCode).toBe(403);
    const missed = await send(alice, 'PATCH', `/rest/v1/reminders?id=eq.${id}`, { status: 'missed' });
    expect(missed.statusCode).toBe(400);
  });

  it('lists, ticks off, acknowledges once and deletes like the app', async () => {
    const list = await get(alice, `/rest/v1/reminders?select=${COLUMNS}&status=in.(pending,done,missed)&order=due_at.asc.nullslast,created_at.desc&limit=200`);
    expect(list.json()).toHaveLength(1);
    expect((await get(bob, `/rest/v1/reminders?select=id`)).json()).toEqual([]);
    const now = new Date().toISOString();
    const done = await send(alice, 'PATCH', `/rest/v1/reminders?id=eq.${id}`, { status: 'done', completed_at: now, updated_at: now }, 'return=minimal');
    expect(done.statusCode).toBe(204);
    const ack = await send(alice, 'PATCH', `/rest/v1/reminders?id=eq.${id}&acknowledged_at=is.null`, { acknowledged_at: now }, 'return=minimal');
    expect(ack.statusCode).toBe(204);
    const between = await get(alice, `/rest/v1/reminders?select=${COLUMNS}&due_at=gte.2026-11-30T00:00:00.000Z&due_at=lte.2026-12-02T00:00:00.000Z&status=in.(pending,done,missed)&order=due_at.asc`);
    expect(between.json()[0]).toMatchObject({ status: 'done' });
    expect((await send(bob, 'DELETE', `/rest/v1/reminders?id=eq.${id}`)).statusCode).toBe(204);
    expect((await t.sql`select 1 from public.reminders where id = ${id}`).length).toBe(1);
    expect((await send(alice, 'DELETE', `/rest/v1/reminders?id=eq.${id}`)).statusCode).toBe(204);
    expect((await t.sql`select 1 from public.reminders where id = ${id}`).length).toBe(0);
  });
});

describe('ai_calls and ai_call_lines', () => {
  it('show a user only their own calls and lines, and cannot be written by clients', async () => {
    const [call] = await t.sql<{ id: string }[]>`
      insert into public.ai_calls (user_id, to_name, to_phone, purpose, status, summary)
      values (${alice.user.id}, 'Ravi', '+919812345678', 'Book a table for two', 'completed', 'Table booked.') returning id::text`;
    await t.sql`insert into public.ai_call_lines (call_id, role, message, seq) values (${call!.id}, 'assistant', 'Hello', 0), (${call!.id}, 'user', 'Hi', 1)`;
    const COLUMNS = 'id,to_name,to_phone,purpose,details,status,scheduled_for,duration_seconds,transcript,summary,outcome,next_step,recording_url,error_message,ended_reason,created_at';
    const mine = await get(alice, `/rest/v1/ai_calls?select=${COLUMNS}&order=created_at.desc&limit=30`);
    expect(mine.json()).toMatchObject([{ id: call!.id, status: 'completed', summary: 'Table booked.' }]);
    expect((await get(bob, `/rest/v1/ai_calls?select=${COLUMNS}&id=eq.${call!.id}&limit=1`)).json()).toEqual([]);
    const lines = await get(alice, `/rest/v1/ai_call_lines?select=id,role,message,seq&call_id=eq.${call!.id}&order=seq.asc`);
    expect(lines.json().map((l: { message: string }) => l.message)).toEqual(['Hello', 'Hi']);
    expect((await get(bob, `/rest/v1/ai_call_lines?select=id&call_id=eq.${call!.id}`)).json()).toEqual([]);
    expect((await send(alice, 'PATCH', `/rest/v1/ai_calls?id=eq.${call!.id}`, { status: 'failed' })).statusCode).toBe(403);
    expect((await send(alice, 'POST', '/rest/v1/ai_calls', { to_phone: '+919812345678', purpose: 'forged call' })).statusCode).toBe(403);
    expect((await send(alice, 'POST', '/rest/v1/ai_call_lines', { call_id: call!.id, role: 'user', message: 'x', seq: 9 })).statusCode).toBe(403);
  });
});
