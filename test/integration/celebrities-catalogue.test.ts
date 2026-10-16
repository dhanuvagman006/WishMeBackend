/**
 * The public celebrity catalogue and the celebrity's own profile, events, media, settings and pricing; free follows;
 * occasions, occasion bookings and wishes; loved ones and occasion alerts. Policies run against the fixture that
 * mirrors the production columns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validatePolicies } from '../../src/compat/postgrest/compiler.js';
import { definePolicy, PolicyRegistry } from '../../src/compat/postgrest/policy.js';
import { rpcs, tables } from '../../src/compat/postgrest/policies/celebrities.js';
import { sql } from '../../src/lib/sql.js';
import { anon, bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

const profilesForEmbeds = definePolicy({
  table: 'profiles',
  read: [{ name: 'owner', rows: (c) => (c.identity.profileId ? sql`${c.col('id')} = ${c.identity.profileId}::uuid` : 'none'), columns: '*' }],
});

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;
let carol: TestSession;
let aliceP: string;
let bobP: string;
let celebId: string;
let freeCelebId: string;
let hiddenCelebId: string;
let occasionId: string;
let celebOccasionId: string;
const STORAGE = 'http://localhost:3000/storage/v1/object/public';

const get = (url: string, token?: string) => t.app.inject({ method: 'GET', url, headers: token ? bearer(token) : anon() });
const send = (method: 'POST' | 'PATCH' | 'DELETE', token: string, url: string, payload?: unknown, prefer = 'return=representation') =>
  t.app.inject({ method, url, headers: { ...bearer(token), prefer }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

beforeAll(async () => {
  t = await bootTest({ policies: [...tables, profilesForEmbeds], rpcs });
  alice = await signUp(t, 'alice-c@example.com', undefined, { first_name: 'Alice', phone: '9000000021' });
  bob = await signUp(t, 'bob-c@example.com', undefined, { first_name: 'Bob', phone: '9000000022' });
  carol = await signUp(t, 'carol-c@example.com', undefined, { first_name: 'Carol', phone: '9000000023' });
  aliceP = await profileIdOf(t, alice.user.id);
  bobP = await profileIdOf(t, bob.user.id);
  const rows = await t.sql<{ id: string }[]>`
    insert into public.celebrities (profile_id, name, category, is_verified, consent_status, available_balance, rating, service_prices)
    values (${bobP}, 'Bob Star', 'Singer', true, 'approved', 1234, 4.5, ${t.sql.json({ general_wish: 1000 })}),
           (null, 'Free Star', 'Actor', true, 'approved', 0, 3.0, ${t.sql.json({})}),
           (null, 'Hidden Star', 'Actor', true, 'approved', 0, 5.0, ${t.sql.json({})})
    returning id`;
  [celebId, freeCelebId, hiddenCelebId] = rows.map((r) => r.id) as [string, string, string];
  await t.sql`update public.celebrities set is_active = false where id = ${hiddenCelebId}`;
  await t.sql`insert into public.celebrity_favorite_pricing (celebrity_id, price) values (${celebId}, 499), (${hiddenCelebId}, 99)`;
  await t.sql`insert into public.celebrity_favorites (user_id, celebrity_id, price_paid, payment_method) values (${aliceP}, ${celebId}, 499, 'wallet')`;
  occasionId = (await t.sql<{ id: string }[]>`insert into public.occasions (name, date, is_featured) values ('Diwali', '2026-11-08', true) returning id`)[0]!.id;
  celebOccasionId = (await t.sql<{ id: string }[]>`
    insert into public.celebrity_occasions (celebrity_id, occasion_type, occasion_name, occasion_date) values (${celebId}, 'birthday', 'Bob''s birthday', '2026-12-01') returning id`)[0]!.id;
});
afterAll(async () => {
  await t.close();
});

describe('policy definitions', () => {
  it('name only columns that exist', () => {
    const registry = new PolicyRegistry().addTables(tables);
    expect(validatePolicies(t.deps.schema, registry)).toEqual([]);
  });
});

describe('celebrities', () => {
  const catalogue =
    '/rest/v1/celebrities?select=' +
    encodeURIComponent('id,name,category,bio,image_url,rating,is_verified,service_prices,celebrity_favorite_pricing!inner(price,is_enabled),celebrity_reviews(count)') +
    '&celebrity_favorite_pricing.is_enabled=eq.true&is_active=eq.true&is_verified=eq.true&consent_status=eq.approved&order=rating.desc.nullslast&limit=50';

  it('serves the home catalogue anonymously (embedded filter included), cached', async () => {
    const res = await get(catalogue);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: celebId, name: 'Bob Star', celebrity_favorite_pricing: [{ price: 499, is_enabled: true }], celebrity_reviews: [{ count: 0 }] }),
    ]);
    expect((await get(catalogue)).headers['x-cache']).toBe('hit');
  });

  it('hides private columns and inactive celebrities from the public', async () => {
    const res = await get(`/rest/v1/celebrities?id=eq.${celebId}&select=*,celebrity_reviews(count)&limit=1`);
    const row = res.json()[0];
    expect(row.name).toBe('Bob Star');
    expect(row.available_balance).toBeNull();
    expect(row.consent_photo_url).toBeNull();
    expect(row.profile_id).toBeNull();
    expect((await get(`/rest/v1/celebrities?id=eq.${hiddenCelebId}&select=id`)).json()).toEqual([]);
    expect((await get(`/rest/v1/celebrities?select=id&available_balance=eq.1234`)).json()).toEqual([]);
  });

  it('shows the owner every column of their own row', async () => {
    const res = await get(`/rest/v1/celebrities?profile_id=eq.${bobP}&select=*&limit=1`, bob.access_token);
    expect(res.json()[0]).toMatchObject({ id: celebId, available_balance: 1234, profile_id: bobP });
  });

  it('answers a balance-only PATCH (WithdrawModal) without writing', async () => {
    const res = await send('PATCH', bob.access_token, `/rest/v1/celebrities?id=eq.${celebId}`, { available_balance: 0 }, 'return=minimal');
    expect(res.statusCode).toBe(204);
    expect((await t.sql`select available_balance from public.celebrities where id = ${celebId}`)[0]!.available_balance).toBe(1234);
  });

  it('lets the owner edit self-service fields only', async () => {
    const ok = await send('PATCH', bob.access_token, `/rest/v1/celebrities?id=eq.${celebId}`, { service_prices: { general_wish: 1200, ugc_ad: 0 }, bio: 'Hi' }, 'return=minimal');
    expect(ok.statusCode).toBe(204);
    const row = await t.sql`select service_prices, bio from public.celebrities where id = ${celebId}`;
    expect(row[0]).toEqual({ service_prices: { general_wish: 1200, ugc_ad: 0 }, bio: 'Hi' });
    for (const body of [{ rating: 5 }, { available_balance: 1, bio: 'x' }, { name: 'Renamed' }, { commission_percentage: 100 }]) {
      expect((await send('PATCH', bob.access_token, `/rest/v1/celebrities?id=eq.${celebId}`, body)).statusCode).toBe(403);
    }
    expect((await send('PATCH', bob.access_token, `/rest/v1/celebrities?id=eq.${celebId}`, { service_prices: { general_wish: -1 } })).statusCode).toBe(400);
    const other = await send('PATCH', alice.access_token, `/rest/v1/celebrities?id=eq.${celebId}`, { bio: 'hacked' }, 'return=minimal');
    expect(other.statusCode).toBe(204);
    expect((await t.sql`select bio from public.celebrities where id = ${celebId}`)[0]!.bio).toBe('Hi');
  });

  it('accepts avatars and consent files only from this server, in the celebrity\'s folder', async () => {
    const external = await send('PATCH', bob.access_token, `/rest/v1/celebrities?id=eq.${celebId}`, { image_url: 'https://evil.example/x.jpg' });
    expect(external.statusCode).toBe(400);
    const elsewhere = await send('PATCH', bob.access_token, `/rest/v1/celebrities?id=eq.${celebId}`, { image_url: `${STORAGE}/celebrity-avatars/someone_else/avatar/1-avatar.jpg` });
    expect(elsewhere.statusCode).toBe(403);
    const avatar = `${STORAGE}/celebrity-avatars/bob_star/avatar/1-avatar.jpg`;
    expect((await send('PATCH', bob.access_token, `/rest/v1/celebrities?id=eq.${celebId}`, { image_url: avatar }, 'return=minimal')).statusCode).toBe(204);

    await t.sql`update public.celebrities set consent_status = 'pending' where id = ${celebId}`;
    const consent = {
      consent_photo_url: `${STORAGE}/verification-docs/${celebId}/consent-photo-1.jpg`,
      consent_video_url: `${STORAGE}/verification-docs/${celebId}/consent-video-1.webm`,
      consent_status: 'submitted',
      consent_given_at: '2000-01-01T00:00:00Z',
    };
    expect((await send('PATCH', bob.access_token, `/rest/v1/celebrities?id=eq.${celebId}`, consent, 'return=minimal')).statusCode).toBe(204);
    const row = await t.sql`select consent_status, consent_given_at > now() - interval '1 minute' as fresh from public.celebrities where id = ${celebId}`;
    expect(row[0]).toEqual({ consent_status: 'submitted', fresh: true });
    expect((await send('PATCH', bob.access_token, `/rest/v1/celebrities?id=eq.${celebId}`, { ...consent, consent_status: 'approved' })).statusCode).toBe(400);
    await t.sql`update public.celebrities set consent_status = 'approved' where id = ${celebId}`;
    await send('PATCH', bob.access_token, `/rest/v1/celebrities?id=eq.${celebId}`, consent, 'return=minimal');
    expect((await t.sql`select consent_status from public.celebrities where id = ${celebId}`)[0]!.consent_status).toBe('approved');
  });
});

describe('celebrity events, media, settings, pricing', () => {
  it('lets the owner manage events; the public sees public ones', async () => {
    const create = await send('POST', bob.access_token, '/rest/v1/celebrity_events', { title: 'Meet', event_type: 'meetup', event_date: '2026-12-24', description: '', location: 'Mumbai', is_public: true, celebrity_id: celebId });
    expect(create.statusCode).toBe(201);
    expect(create.json()[0].event_type).toBe('other');
    const priv = await send('POST', bob.access_token, '/rest/v1/celebrity_events', { title: 'Private', event_type: 'concert', event_date: '2026-12-25', is_public: false, celebrity_id: celebId }, 'return=minimal');
    expect(priv.statusCode).toBe(201);
    expect((await send('POST', alice.access_token, '/rest/v1/celebrity_events', { title: 'Fake', event_type: 'other', event_date: '2026-12-25', celebrity_id: celebId })).statusCode).toBe(403);
    expect((await get(`/rest/v1/celebrity_events?celebrity_id=eq.${celebId}&is_public=eq.true&order=event_date.asc`)).json().map((e: { title: string }) => e.title)).toEqual(['Meet']);
    expect((await get(`/rest/v1/celebrity_events?celebrity_id=eq.${celebId}&order=event_date.asc&limit=30`, bob.access_token)).json()).toHaveLength(2);
    const id = create.json()[0].id as string;
    await send('DELETE', alice.access_token, `/rest/v1/celebrity_events?id=eq.${id}`, undefined, 'return=minimal');
    expect((await t.sql`select count(*)::int as n from public.celebrity_events`)[0]!.n).toBe(2);
    expect((await send('PATCH', bob.access_token, `/rest/v1/celebrity_events?id=eq.${id}`, { title: 'Meetup' }, 'return=minimal')).statusCode).toBe(204);
    expect((await send('DELETE', bob.access_token, `/rest/v1/celebrity_events?id=eq.${id}`, undefined, 'return=minimal')).statusCode).toBe(204);
    expect((await t.sql`select count(*)::int as n from public.celebrity_events`)[0]!.n).toBe(1);
  });

  it('stores promo media from this server only, mapping media_url onto file_url, private until approved', async () => {
    const url = `${STORAGE}/promotional-content/bob_star/promotional/photo/1-promo.jpg`;
    const ok = await send('POST', bob.access_token, '/rest/v1/celebrity_media', { celebrity_id: celebId, media_url: url, media_type: 'photo' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()[0]).toMatchObject({ file_url: url, media_type: 'photo', title: 'Promotional photo', is_public: false });
    expect((await send('POST', bob.access_token, '/rest/v1/celebrity_media', { celebrity_id: celebId, media_url: 'https://evil.example/a.jpg', media_type: 'photo' })).statusCode).toBe(400);
    expect((await send('POST', alice.access_token, '/rest/v1/celebrity_media', { celebrity_id: celebId, media_url: url, media_type: 'photo' })).statusCode).toBe(403);
    expect((await get(`/rest/v1/celebrity_media?celebrity_id=eq.${celebId}&is_public=eq.true&order=created_at.desc`)).json()).toEqual([]);
    await t.sql`update public.celebrity_media set is_public = true`;
    expect((await get(`/rest/v1/celebrity_media?celebrity_id=eq.${celebId}&is_public=eq.true`)).json()[0].file_url).toBe(url);
  });

  it('upserts the owner\'s settings on celebrity_id', async () => {
    const up = (v: boolean) =>
      t.app.inject({ method: 'POST', url: '/rest/v1/celebrity_settings', headers: { ...bearer(bob.access_token), prefer: 'resolution=merge-duplicates,return=minimal' }, payload: { celebrity_id: celebId, ai_auto_reply_enabled: v } });
    expect((await up(true)).statusCode).toBe(201);
    expect((await up(false)).statusCode).toBe(201);
    expect(await t.sql`select ai_auto_reply_enabled from public.celebrity_settings`).toEqual([{ ai_auto_reply_enabled: false }]);
    const other = await t.app.inject({ method: 'POST', url: '/rest/v1/celebrity_settings', headers: { ...bearer(alice.access_token), prefer: 'resolution=merge-duplicates' }, payload: { celebrity_id: celebId, ai_auto_reply_enabled: true } });
    expect(other.statusCode).toBe(403);
    expect((await get(`/rest/v1/celebrity_settings?celebrity_id=eq.${celebId}&limit=1`, alice.access_token)).json()).toEqual([]);
  });

  it('shows only enabled subscription prices', async () => {
    await t.sql`update public.celebrity_favorite_pricing set is_enabled = false where celebrity_id = ${hiddenCelebId}`;
    const res = await get('/rest/v1/celebrity_favorite_pricing?is_enabled=eq.false');
    expect(res.json()).toEqual([]);
    expect((await get(`/rest/v1/celebrity_favorite_pricing?celebrity_id=eq.${celebId}&is_enabled=eq.true&select=price&limit=1`, alice.access_token)).json()).toEqual([{ price: 499 }]);
  });
});

describe('favourites', () => {
  it('lists own subscriptions with the celebrity embed, and followers for the celebrity', async () => {
    const mine = await get(`/rest/v1/celebrity_favorites?select=*,celebrities(*)&user_id=eq.${aliceP}&status=eq.active`, alice.access_token);
    expect(mine.json()[0].celebrities.name).toBe('Bob Star');
    const followers = await get(`/rest/v1/celebrity_favorites?celebrity_id=eq.${celebId}&select=*&order=created_at.desc&limit=50`, bob.access_token);
    expect(followers.json()[0]).toMatchObject({ user_id: aliceP, status: 'active', price_paid: null });
    expect((await get(`/rest/v1/celebrity_favorites?select=id`, carol.access_token)).json()).toEqual([]);
    const count = await t.app.inject({ method: 'HEAD', url: `/rest/v1/celebrity_favorites?select=id&user_id=eq.${aliceP}&limit=1`, headers: { ...bearer(alice.access_token), prefer: 'count=exact' } });
    expect(count.headers['content-range']).toBe('0-0/1');
  });

  it('allows free follows only, never a free paid subscription, and unfollowing free ones', async () => {
    expect((await send('POST', carol.access_token, '/rest/v1/celebrity_favorites', { celebrity_id: celebId, status: 'active' })).statusCode).toBe(403);
    const free = await send('POST', carol.access_token, '/rest/v1/celebrity_favorites', { celebrity_id: freeCelebId });
    expect(free.statusCode).toBe(201);
    expect(free.json()[0]).toMatchObject({ celebrity_id: freeCelebId, status: 'active', price_paid: 0 });
    expect((await send('DELETE', carol.access_token, `/rest/v1/celebrity_favorites?celebrity_id=eq.${freeCelebId}`, undefined, 'return=minimal')).statusCode).toBe(204);
    await send('DELETE', alice.access_token, `/rest/v1/celebrity_favorites?celebrity_id=eq.${celebId}`, undefined, 'return=minimal');
    expect((await t.sql`select count(*)::int as n from public.celebrity_favorites`)[0]!.n).toBe(1);
  });
});

describe('occasions', () => {
  it('serves occasions and public celebrity occasions anonymously', async () => {
    expect((await get('/rest/v1/occasions?is_active=eq.true&order=date.asc')).json()[0]).toMatchObject({ name: 'Diwali', is_featured: true });
    const res = await get(`/rest/v1/celebrity_occasions?select=*,celebrities:celebrity_id(id,name,image_url,category)&celebrity_id=in.(${celebId})&is_public=eq.true&order=occasion_date.asc`, alice.access_token);
    expect(res.json()[0]).toMatchObject({ occasion_name: "Bob's birthday", celebrities: { name: 'Bob Star' } });
  });

  it('books an occasion wish for subscribers only, free whatever the client says', async () => {
    const body = { user_id: aliceP, occasion_id: occasionId, celebrity_id: celebId, booking_type: 'video', recipient_name: 'Mom', recipient_email: null, recipient_phone: null, message: 'Happy Diwali', price: 999, status: 'pending' };
    const res = await send('POST', alice.access_token, '/rest/v1/occasion_bookings', body);
    expect(res.statusCode).toBe(201);
    expect(res.json()[0]).toMatchObject({ price: 0, status: 'pending', user_id: aliceP });
    expect((await send('POST', carol.access_token, '/rest/v1/occasion_bookings', { ...body, user_id: undefined })).statusCode).toBe(400);
    expect((await get('/rest/v1/occasion_bookings?select=id', carol.access_token)).json()).toEqual([]);
  });

  it('sends occasion wishes to subscribed celebrities and lists them with the occasion embed', async () => {
    const short = await send('POST', alice.access_token, '/rest/v1/occasion_wishes', { user_id: aliceP, celebrity_id: celebId, occasion_id: celebOccasionId, message: 'Hi' });
    expect(short.statusCode).toBe(400);
    const ok = await send('POST', alice.access_token, '/rest/v1/occasion_wishes', { user_id: aliceP, celebrity_id: celebId, occasion_id: celebOccasionId, message: 'Happy birthday Bob!' });
    expect(ok.statusCode).toBe(201);
    expect((await send('POST', carol.access_token, '/rest/v1/occasion_wishes', { celebrity_id: celebId, occasion_id: celebOccasionId, message: 'Happy birthday Bob!' })).statusCode).toBe(400);
    const list = await get(`/rest/v1/occasion_wishes?select=*,celebrity_occasions!inner(*,celebrities:celebrity_id(id,name,image_url,category))&user_id=eq.${aliceP}&order=created_at.desc&limit=20`, alice.access_token);
    expect(list.json()[0]).toMatchObject({ message: 'Happy birthday Bob!', reply_message: null, celebrity_occasions: { occasion_name: "Bob's birthday", celebrities: { name: 'Bob Star' } } });
  });
});

describe('loved ones and alerts', () => {
  let personId: string;

  it('creates people for the caller only, whatever user_id the client sends', async () => {
    const res = await send('POST', alice.access_token, '/rest/v1/loved_ones', { user_id: bobP, first_name: ' Mom ', last_name: null, email: null, phone: null, date_of_birth: '1965-03-02', relationship: 'Family', notes: null, occasions: [] });
    expect(res.statusCode).toBe(201);
    personId = res.json()[0].id;
    expect(res.json()[0]).toMatchObject({ user_id: aliceP, first_name: 'Mom', occasions: [] });
    expect((await send('POST', alice.access_token, '/rest/v1/loved_ones', { first_name: '' })).statusCode).toBe(400);
    expect((await get(`/rest/v1/loved_ones?user_id=eq.${aliceP}&order=first_name.asc`, bob.access_token)).json()).toEqual([]);
  });

  it('replaces occasions and upserts alerts on (user, person, occasion)', async () => {
    const occ = [{ id: 'occ1', name: 'Birthday', date: '2027-03-02', type: 'Birthday' }];
    expect((await send('PATCH', alice.access_token, `/rest/v1/loved_ones?id=eq.${personId}`, { occasions: occ }, 'return=minimal')).statusCode).toBe(204);
    expect((await send('PATCH', alice.access_token, `/rest/v1/loved_ones?id=eq.${personId}`, { occasions: 'nope' })).statusCode).toBe(400);
    const upsert = (body: Record<string, unknown>, token = alice.access_token) =>
      t.app.inject({ method: 'POST', url: '/rest/v1/occasion_alerts?on_conflict=user_id,loved_one_id,occasion_name', headers: { ...bearer(token), prefer: 'resolution=merge-duplicates,return=minimal' }, payload: body });
    const alert = { user_id: aliceP, loved_one_id: personId, occasion_name: 'Birthday', occasion_type: 'birthday', occasion_date: '2027-03-02' };
    expect((await upsert(alert)).statusCode).toBe(201);
    expect((await upsert({ ...alert, occasion_date: '2027-03-03', alert_days_before: 7, reminder_time: '08:30:00' })).statusCode).toBe(201);
    const rows = await t.sql`select occasion_date::text, alert_days_before from public.occasion_alerts`;
    expect(rows).toEqual([{ occasion_date: '2027-03-03', alert_days_before: 7 }]);
    expect((await upsert({ ...alert, occasion_type: 'Birthday' })).statusCode).toBe(400);
    expect((await upsert({ loved_one_id: personId, occasion_name: 'X', occasion_type: 'other', occasion_date: '2027-01-01' }, carol.access_token)).statusCode).toBe(403);
    const list = await get(`/rest/v1/occasion_alerts?select=*,loved_ones(first_name,last_name),celebrities!occasion_alerts_celebrity_id_fkey(name)&user_id=eq.${aliceP}&order=occasion_date.asc`, alice.access_token);
    expect(list.json()[0]).toMatchObject({ occasion_name: 'Birthday', loved_ones: { first_name: 'Mom', last_name: null }, celebrities: null });
  });

  it('deletes a person together with their alerts, and nobody else\'s', async () => {
    expect((await send('DELETE', bob.access_token, `/rest/v1/loved_ones?id=eq.${personId}`, undefined, 'return=minimal')).statusCode).toBe(204);
    expect((await t.sql`select count(*)::int as n from public.loved_ones`)[0]!.n).toBe(1);
    expect((await send('DELETE', alice.access_token, `/rest/v1/loved_ones?id=eq.${personId}`, undefined, 'return=minimal')).statusCode).toBe(204);
    expect((await t.sql`select count(*)::int as n from public.loved_ones`)[0]!.n).toBe(0);
    expect((await t.sql`select count(*)::int as n from public.occasion_alerts`)[0]!.n).toBe(0);
  });
});
