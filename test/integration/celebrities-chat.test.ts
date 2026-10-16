/**
 * Fan / celebrity chat: participant-only reads with the conversations FK-hint embed, message inserts with the sender
 * taken from the token, voice-note URL checks, the conversation limit, server-maintained counters, read markers, the
 * no-op client counter PATCHes, and realtime authorisation (database participant check).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePolicy } from '../../src/compat/postgrest/policy.js';
import { rpcs, tables } from '../../src/compat/postgrest/policies/celebrities.js';
import { sql } from '../../src/lib/sql.js';
import { bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

const profilesForEmbeds = definePolicy({
  table: 'profiles',
  read: [{ name: 'names', rows: (c) => (c.auth.kind === 'anon' ? 'none' : 'all'), columns: ['id', 'first_name', 'last_name'] }],
});

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;
let carol: TestSession;
let aliceP: string;
let bobP: string;
let celebId: string;
let convId: string;
const STORAGE = 'http://localhost:3000/storage/v1/object/public';

const get = (url: string, token: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) });
const send = (method: 'POST' | 'PATCH', token: string, url: string, payload: unknown) =>
  t.app.inject({ method, url, headers: { ...bearer(token), prefer: 'return=minimal' }, payload: payload as Record<string, unknown> });
const message = (token: string, text: string, extra: Record<string, unknown> = {}) =>
  send('POST', token, '/rest/v1/messages', { conversation_id: convId, sender_id: aliceP, sender_type: 'user', message_text: text, is_read: false, is_ai_generated: false, ...extra });
const conv = async () =>
  (await t.sql`select unread_count_user, unread_count_celebrity, message_count, is_closed, last_message_at > now() - interval '1 minute' as recent from public.conversations where id = ${convId}`)[0]!;

beforeAll(async () => {
  t = await bootTest({ policies: [...tables, profilesForEmbeds], rpcs });
  alice = await signUp(t, 'alice-chat@example.com', undefined, { first_name: 'Alice', last_name: 'A', phone: '9000000031' });
  bob = await signUp(t, 'bob-chat@example.com', undefined, { first_name: 'Bob', phone: '9000000032' });
  carol = await signUp(t, 'carol-chat@example.com', undefined, { first_name: 'Carol', phone: '9000000033' });
  aliceP = await profileIdOf(t, alice.user.id);
  bobP = await profileIdOf(t, bob.user.id);
  celebId = (await t.sql<{ id: string }[]>`insert into public.celebrities (profile_id, name, category) values (${bobP}, 'Bob Star', 'Singer') returning id`)[0]!.id;
  convId = (await t.sql<{ id: string }[]>`
    insert into public.conversations (user_id, celebrity_id, last_message_at) values (${aliceP}, ${celebId}, now() - interval '1 day') returning id`)[0]!.id;
});
afterAll(async () => {
  await t.close();
});

describe('conversations', () => {
  it('shows participants their conversations with the celebrity embed, and nobody else', async () => {
    const fan = await get(`/rest/v1/conversations?select=*,celebrity:celebrities!conversations_celebrity_id_fkey(id,name,image_url)&user_id=eq.${aliceP}&order=last_message_at.desc`, alice.access_token);
    expect(fan.json()).toEqual([expect.objectContaining({ id: convId, celebrity: { id: celebId, name: 'Bob Star', image_url: null } })]);
    const dash = await get(`/rest/v1/conversations?celebrity_id=eq.${celebId}&select=*,profiles(first_name,last_name)&order=last_message_at.desc&limit=30`, bob.access_token);
    expect(dash.json()[0].profiles).toEqual({ first_name: 'Alice', last_name: 'A' });
    expect((await get('/rest/v1/conversations?select=id', carol.access_token)).json()).toEqual([]);
  });
});

describe('sending messages', () => {
  it('stores the fan message as the caller and maintains last_message_at and the celebrity unread counter', async () => {
    const res = await message(alice.access_token, '  Hello Bob  ');
    expect(res.statusCode).toBe(201);
    const row = await t.sql`select sender_id, sender_type, message_text, is_ai_generated from public.messages`;
    expect(row).toEqual([{ sender_id: aliceP, sender_type: 'user', message_text: 'Hello Bob', is_ai_generated: false }]);
    // message_count is the production limit trigger's job, not repeated here.
    expect(await conv()).toMatchObject({ unread_count_celebrity: 1, unread_count_user: 0, message_count: 0, recent: true });
  });

  it('refuses impersonation, AI flags, outsiders, empty and oversized text', async () => {
    expect((await message(alice.access_token, 'x', { sender_type: 'celebrity' })).statusCode).toBe(403);
    expect((await message(alice.access_token, 'x', { sender_id: bobP })).statusCode).toBe(403);
    expect((await message(alice.access_token, 'x', { is_ai_generated: true })).statusCode).toBe(403);
    expect((await message(alice.access_token, 'x', { conversation_message_number: 1 })).statusCode).toBe(403);
    expect((await message(carol.access_token, 'x', { sender_id: undefined })).statusCode).toBe(403);
    expect((await message(alice.access_token, '   ')).statusCode).toBe(400);
    expect((await message(alice.access_token, 'a'.repeat(2001))).statusCode).toBe(400);
  });

  it('accepts voice notes only from this server, in the sender\'s own folder', async () => {
    expect((await message(alice.access_token, `[Voice Note: ${STORAGE}/voice-notes/${aliceP}/voice-1.m4a]`)).statusCode).toBe(201);
    expect((await message(alice.access_token, `[Voice Note: ${STORAGE}/voice-notes/${bobP}/voice-1.m4a]`)).statusCode).toBe(403);
    expect((await message(alice.access_token, '[Voice Note: https://evil.example/a.m4a]')).statusCode).toBe(400);
    expect((await message(alice.access_token, 'Look [Greeting Card: https://evil.example/a.png]')).statusCode).toBe(403);
  });

  it('lets the celebrity reply and bumps the fan unread counter', async () => {
    const res = await send('POST', bob.access_token, '/rest/v1/messages', { conversation_id: convId, sender_id: bobP, sender_type: 'celebrity', message_text: 'Hi Alice' });
    expect(res.statusCode).toBe(201);
    expect(await conv()).toMatchObject({ unread_count_user: 1 });
  });

  it('reads messages for participants only', async () => {
    const mine = await get(`/rest/v1/messages?select=*&conversation_id=eq.${convId}&order=created_at.desc&limit=50`, alice.access_token);
    expect(mine.json()).toHaveLength(3);
    const preview = await get(`/rest/v1/messages?select=message_text,sender_type&conversation_id=eq.${convId}&order=created_at.desc&limit=1`, bob.access_token);
    expect(preview.json()).toEqual([{ message_text: 'Hi Alice', sender_type: 'celebrity' }]);
    expect((await get(`/rest/v1/messages?select=id&conversation_id=eq.${convId}`, carol.access_token)).json()).toEqual([]);
  });
});

describe('read markers and counters', () => {
  it('marks only messages addressed to the caller and resets the caller\'s counter', async () => {
    expect((await send('PATCH', alice.access_token, `/rest/v1/messages?conversation_id=eq.${convId}&is_read=eq.false`, { is_read: true })).statusCode).toBe(204);
    const read = await t.sql`select sender_type, is_read from public.messages order by sender_type, created_at`;
    expect(read.filter((r) => r.sender_type === 'celebrity').every((r) => r.is_read)).toBe(true);
    expect(read.filter((r) => r.sender_type === 'user').every((r) => !r.is_read)).toBe(true);
    expect(await conv()).toMatchObject({ unread_count_user: 0, unread_count_celebrity: 2 });
    expect((await send('PATCH', bob.access_token, `/rest/v1/messages?conversation_id=eq.${convId}&sender_id=neq.${bobP}&is_read=eq.false`, { is_read: true })).statusCode).toBe(204);
    expect((await t.sql`select count(*)::int as n from public.messages where not is_read`)[0]!.n).toBe(0);
    expect(await conv()).toMatchObject({ unread_count_celebrity: 0 });
    expect((await send('PATCH', alice.access_token, `/rest/v1/messages?conversation_id=eq.${convId}`, { message_text: 'edited' })).statusCode).toBe(403);
  });

  it('ignores the client\'s counter writes except resetting its own unread count', async () => {
    await message(alice.access_token, 'Another');
    expect((await send('PATCH', alice.access_token, `/rest/v1/conversations?id=eq.${convId}`, { unread_count_celebrity: 99 })).statusCode).toBe(204);
    expect((await send('PATCH', alice.access_token, `/rest/v1/conversations?id=eq.${convId}`, { last_message_at: '2000-01-01T00:00:00Z' })).statusCode).toBe(204);
    expect(await conv()).toMatchObject({ unread_count_celebrity: 1, recent: true });
    expect((await send('PATCH', alice.access_token, `/rest/v1/conversations?id=eq.${convId}`, { is_closed: false })).statusCode).toBe(403);
    expect((await send('PATCH', carol.access_token, `/rest/v1/conversations?id=eq.${convId}`, { unread_count_celebrity: 0 })).statusCode).toBe(204);
    expect(await conv()).toMatchObject({ unread_count_celebrity: 1 });
  });
});

describe('conversation limit', () => {
  it('stops fan messages at the limit with the trigger\'s words, but lets the celebrity close out', async () => {
    await t.sql`insert into public.platform_settings (setting_key, setting_value) values ('conversation_message_limit', '10')`;
    await t.sql`update public.conversations set message_count = 9 where id = ${convId}`;
    const res = await message(alice.access_token, 'One more?');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('This conversation has been closed after reaching the message limit');
    const reply = await send('POST', bob.access_token, '/rest/v1/messages', { conversation_id: convId, sender_type: 'celebrity', message_text: 'Bye!' });
    expect(reply.statusCode).toBe(201);
    await t.sql`update public.conversations set message_count = 0, is_closed = true where id = ${convId}`;
    expect((await message(alice.access_token, 'Closed?')).statusCode).toBe(400);
  });
});

describe('realtime', () => {
  it('authorises message subscriptions with a database participant check', async () => {
    const rule = tables.find((p) => p.table === 'messages')!.realtime!;
    const user = { kind: 'user' } as never;
    expect(await rule.authorize(user, { profileId: aliceP, celebrityIds: [], profileRole: 'user' }, 'conversation_id', convId, t.deps)).toBe(true);
    expect(await rule.authorize(user, { profileId: bobP, celebrityIds: [celebId], profileRole: 'user' }, 'conversation_id', convId, t.deps)).toBe(true);
    expect(await rule.authorize(user, { profileId: bobP, celebrityIds: [], profileRole: 'user' }, 'conversation_id', convId, t.deps)).toBe(false);
    expect(await rule.authorize(user, { profileId: aliceP, celebrityIds: [], profileRole: 'user' }, 'conversation_id', 'not-a-uuid', t.deps)).toBe(false);
    const convRule = tables.find((p) => p.table === 'conversations')!.realtime!;
    expect(convRule.authorize(user, { profileId: bobP, celebrityIds: [celebId], profileRole: 'user' }, 'celebrity_id', celebId, t.deps)).toBe(true);
    expect(convRule.authorize(user, { profileId: aliceP, celebrityIds: [], profileRole: 'user' }, 'celebrity_id', celebId, t.deps)).toBe(false);
  });
});
