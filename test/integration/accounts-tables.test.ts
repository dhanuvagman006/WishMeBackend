/**
 * Accounts read policies, the profile update guard, the anonymous lookups (phone reset, application status), push
 * tokens, celebrity applications and the referral RPCs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anon, bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;
let aliceProfile: string;
let bobProfile: string;
let bobCeleb: string;

const get = (url: string, headers: Record<string, string>) => t.app.inject({ method: 'GET', url, headers });

beforeAll(async () => {
  t = await bootTest();
  alice = await signUp(t, 'alice.acc@example.com', undefined, { first_name: 'Alice', last_name: 'Rao', phone: '9000000201' });
  bob = await signUp(t, 'bob.acc@example.com', undefined, { first_name: 'Bob', last_name: 'Das', phone: '+919000000202' });
  aliceProfile = await profileIdOf(t, alice.user.id);
  bobProfile = await profileIdOf(t, bob.user.id);
  await t.sql`update public.profiles set aadhaar_number = '123412341234', pan_number = 'ABCDE1234F', bank_account_number = '1234567890',
    address = '12 MG Road', phone = '9000000201', wallet_balance = 75 where id = ${aliceProfile}`;
  const c = await t.sql<{ id: string }[]>`insert into public.celebrities (profile_id, name, category) values (${bobProfile}, 'Bob Star', 'Singer') returning id`;
  bobCeleb = c[0]!.id;
  await t.sql`insert into public.celebrity_favorites (user_id, celebrity_id, price_paid) values (${aliceProfile}, ${bobCeleb}, 499)`;
  await t.deps.resolver.forgetIdentity(bob.user.id);
});
afterAll(async () => {
  await t.close();
});

describe('profiles reads', () => {
  it('gives the owner every column, by profile id or by auth user id', async () => {
    const byUser = await get(`/rest/v1/profiles?select=id,wallet_balance,referral_code,celebrities(id)&user_id=eq.${alice.user.id}&limit=1`, bearer(alice.access_token));
    expect(byUser.statusCode).toBe(200);
    expect(byUser.json()[0]).toMatchObject({ id: aliceProfile, wallet_balance: 75 });
    const all = await get(`/rest/v1/profiles?id=eq.${aliceProfile}&select=*`, bearer(alice.access_token));
    expect(all.json()[0].aadhaar_number).toBe('123412341234');
  });

  it('shows other signed-in users only the public card', async () => {
    const res = await get(`/rest/v1/profiles?id=eq.${aliceProfile}&select=first_name,last_name,email,phone,wallet_balance,aadhaar_number`, bearer(bob.access_token));
    // Bob is a celebrity Alice follows: he may see her email (FollowersTab), nothing private.
    expect(res.json()).toEqual([{ first_name: 'Alice', last_name: 'Rao', email: 'alice.acc@example.com', phone: null, wallet_balance: null, aadhaar_number: null }]);
    const reverse = await get(`/rest/v1/profiles?id=eq.${bobProfile}&select=first_name,email`, bearer(alice.access_token));
    expect(reverse.json()).toEqual([{ first_name: 'Bob', email: null }]);
  });

  it('shows anonymous callers nothing (edit-profile loads with the anon key)', async () => {
    const res = await get(`/rest/v1/profiles?user_id=eq.${alice.user.id}&select=*`, anon());
    expect(res.json()).toEqual([]);
  });
});

describe('profiles PATCH (edit-profile)', () => {
  const patch = (payload: Record<string, unknown>, token = alice.access_token) =>
    t.app.inject({ method: 'PATCH', url: `/rest/v1/profiles?user_id=eq.${alice.user.id}`, headers: { ...bearer(token), prefer: 'return=minimal' }, payload });

  it('keeps private fields the anon-loaded form sends back blank', async () => {
    const res = await patch({
      first_name: 'Alicia', last_name: 'Rao', phone: '', avatar_url: null, address: '', bank_account_number: '', bank_name: '', bank_ifsc: '',
      bank_account_holder_name: '', aadhaar_number: '', pan_number: '', profile_completion_percentage: 150,
    });
    expect(res.statusCode).toBe(204);
    const row = (await t.sql`select first_name, phone, address, aadhaar_number, pan_number, bank_account_number, profile_completion_percentage as pct from public.profiles where id = ${aliceProfile}`)[0];
    expect(row).toEqual({ first_name: 'Alicia', phone: '9000000201', address: '12 MG Road', aadhaar_number: '123412341234', pan_number: 'ABCDE1234F', bank_account_number: '1234567890', pct: 100 });
  });

  it('validates identity and bank fields', async () => {
    expect((await patch({ pan_number: 'NOTAPAN' })).statusCode).toBe(400);
    expect((await patch({ aadhaar_number: '1234' })).statusCode).toBe(400);
    expect((await patch({ bank_ifsc: 'XX' })).statusCode).toBe(400);
    expect((await patch({ pan_number: 'abcde9999z', aadhaar_number: '5555 6666 7777' })).statusCode).toBe(204);
    const row = (await t.sql`select pan_number, aadhaar_number from public.profiles where id = ${aliceProfile}`)[0];
    expect(row).toEqual({ pan_number: 'ABCDE9999Z', aadhaar_number: '555566667777' });
  });

  it('refuses server-owned columns and other users\' rows', async () => {
    expect((await patch({ wallet_balance: 1e6 })).statusCode).toBe(403);
    expect((await patch({ role: 'admin' })).statusCode).toBe(403);
    expect((await patch({ referral_code: 'MINE' })).statusCode).toBe(403);
    const other = await t.app.inject({ method: 'PATCH', url: `/rest/v1/profiles?id=eq.${bobProfile}`, headers: bearer(alice.access_token), payload: { first_name: 'Hacked' } });
    expect(other.statusCode).toBe(204);
    expect((await t.sql`select first_name from public.profiles where id = ${bobProfile}`)[0]!.first_name).toBe('Bob');
  });
});

describe('anonymous forgot-password by phone', () => {
  const lookup = (phone: string) => get(`/rest/v1/profiles?select=email&phone=eq.${encodeURIComponent(phone)}&limit=1`, anon());

  it('never returns the real email, but mails the reset link to the owner', async () => {
    const before = t.mailer.sent.length;
    const res = await lookup('+919000000202');
    expect(res.statusCode).toBe(200);
    const [row] = res.json() as Array<{ email: string }>;
    expect(row!.email).toMatch(/^[0-9a-f]{24}@reset\.wishme\.invalid$/);
    for (let i = 0; i < 50 && !t.mailer.sent.slice(before).some((m) => m.to === 'bob.acc@example.com'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(t.mailer.sent.slice(before).find((m) => m.to === 'bob.acc@example.com')?.subject).toMatch(/reset/i);
    // The app's follow-up recover call with the placeholder is a no-op that still answers 200.
    const rec = await t.app.inject({ method: 'POST', url: '/auth/v1/recover', headers: anon(), payload: { email: row!.email } });
    expect(rec.statusCode).toBe(200);
  });

  it('answers unknown numbers exactly the same way', async () => {
    const res = await lookup('9999999999');
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].email).toMatch(/@reset\.wishme\.invalid$/);
    const junk = await lookup('not-a-phone');
    expect(junk.json()[0].email).toMatch(/@reset\.wishme\.invalid$/);
  });
});

describe('catalogue and settings', () => {
  it('serves active plans and allowlisted settings only', async () => {
    await t.sql`insert into public.plans (name, price, is_active) values ('basic', 0, true), ('legacy', 10, false)`;
    await t.sql`insert into public.platform_settings (setting_key, setting_value) values ('ugc_video_price', '500'), ('razorpay_secret', 'x')`;
    const plans = await get('/rest/v1/plans?is_active=eq.true&order=price.asc', anon());
    expect(plans.json().map((p: { name: string }) => p.name)).toEqual(['basic']);
    const all = await get('/rest/v1/platform_settings?select=setting_key', anon());
    expect(all.json()).toEqual([{ setting_key: 'ugc_video_price' }]);
    const price = await get('/rest/v1/platform_settings?setting_key=eq.ugc_video_price&select=setting_value&limit=1', bearer(alice.access_token));
    expect(price.json()).toEqual([{ setting_value: '500' }]);
    const write = await t.app.inject({ method: 'POST', url: '/rest/v1/platform_settings', headers: bearer(alice.access_token), payload: { setting_key: 'ugc_video_price', setting_value: 1 } });
    expect(write.statusCode).toBe(403);
  });

  it('serves celebrity categories to anonymous callers', async () => {
    await t.sql`insert into public.celebrity_categories (name) values ('Singer'), ('Actor')`;
    const res = await get('/rest/v1/celebrity_categories?select=id,name&is_active=eq.true&order=name.asc', anon());
    expect(res.json().map((c: { name: string }) => c.name)).toEqual(['Actor', 'Singer']);
  });
});

describe('own-row money history', () => {
  it("reads only the caller's wallet rows", async () => {
    await t.sql`insert into public.wallet_transactions (user_id, transaction_type, amount) values (${aliceProfile}, 'deposit', 10), (${bobProfile}, 'deposit', 30)`;
    const res = await get(`/rest/v1/wallet_transactions?user_id=eq.${aliceProfile}&select=amount`, bearer(alice.access_token));
    expect(res.json()).toEqual([{ amount: 10 }]);
    // TransactionsTab's legacy retry with the auth user id finds nothing (user_id references profiles in production).
    expect((await get(`/rest/v1/wallet_transactions?user_id=eq.${alice.user.id}&select=amount`, bearer(alice.access_token))).json()).toEqual([]);
    const peek = await get(`/rest/v1/wallet_transactions?user_id=eq.${bobProfile}&select=amount`, bearer(alice.access_token));
    expect(peek.json()).toEqual([]);
  });

  it('reads celebrity wallet rows only for the owning celebrity', async () => {
    await t.sql`insert into public.celebrity_wallet_transactions (celebrity_id, transaction_type, amount, status) values (${bobCeleb}, 'earning', 70, 'completed')`;
    const byCeleb = await get(`/rest/v1/celebrity_wallet_transactions?celebrity_id=eq.${bobCeleb}&order=created_at.desc&limit=50`, bearer(bob.access_token));
    expect(byCeleb.json()).toEqual([expect.objectContaining({ amount: 70, transaction_type: 'earning' })]);
    const alicePeek = await get(`/rest/v1/celebrity_wallet_transactions?celebrity_id=eq.${bobCeleb}`, bearer(alice.access_token));
    expect(alicePeek.json()).toEqual([]);
  });

  it('reads referral transactions as the referrer only', async () => {
    await t.sql`insert into public.referral_transactions (referrer_id, referred_id, commission_level, commission_amount, status, order_type) values (${aliceProfile}, ${bobProfile}, 1, 25, 'completed', 'ugc_video')`;
    expect((await get(`/rest/v1/referral_transactions?referrer_id=eq.${aliceProfile}&select=*`, bearer(alice.access_token))).json()).toHaveLength(1);
    expect((await get(`/rest/v1/referral_transactions?referrer_id=eq.${aliceProfile}&select=*`, bearer(bob.access_token))).json()).toEqual([]);
  });
});

describe('push_tokens', () => {
  it('upserts on the token with the auth user id as owner', async () => {
    const body = { token: 'ExponentPushToken[abcdefghijklmnop]', platform: 'android', last_seen_at: new Date().toISOString() };
    const headers = { ...bearer(alice.access_token), prefer: 'resolution=merge-duplicates' };
    expect((await t.app.inject({ method: 'POST', url: '/rest/v1/push_tokens', headers, payload: body })).statusCode).toBe(201);
    expect((await t.app.inject({ method: 'POST', url: '/rest/v1/push_tokens', headers, payload: body })).statusCode).toBe(201);
    const rows = await t.sql`select user_id::text as u from public.push_tokens`;
    expect(rows).toEqual([{ u: alice.user.id }]);
    const bad = await t.app.inject({ method: 'POST', url: '/rest/v1/push_tokens', headers, payload: { token: 'nope', platform: 'ios' } });
    expect(bad.statusCode).toBe(400);
    const noPlatform = await t.app.inject({ method: 'POST', url: '/rest/v1/push_tokens', headers, payload: { token: 'ExponentPushToken[zzzzzzzzzzzz]' } });
    expect(noPlatform.statusCode).toBe(400);
    const anonPost = await t.app.inject({ method: 'POST', url: '/rest/v1/push_tokens', headers: anon(), payload: body });
    expect(anonPost.statusCode).toBe(401);
  });
});

describe('celebrity applications', () => {
  it('accepts both form shapes, forces pending and answers the anonymous status check with id and status only', async () => {
    const current = await t.app.inject({
      method: 'POST', url: '/rest/v1/celebrity_applications', headers: { ...anon(), prefer: 'return=minimal' },
      payload: { first_name: 'Kiran', last_name: 'M', email: 'Kiran@Example.com', phone: '9000000300', date_of_birth: '1990-01-02', stage_name: 'KM', category: 'Singer', bio: 'b', achievements: 'a', portfolio_link: null, social_media: { instagram: '@km', youtube: '' }, status: 'approved' },
    });
    expect(current.statusCode).toBe(201);
    const legacy = await t.app.inject({
      method: 'POST', url: '/rest/v1/celebrity_applications', headers: bearer(alice.access_token),
      payload: { first_name: 'Alice', last_name: 'Rao', email: 'alice.acc@example.com', phone: '9000000201', dob: '1991-05-06', stage_name: '', category: 'Actor', bio: '', achievements: '', instagram: '@a', youtube: '', twitter: '', portfolio: '' },
    });
    expect(legacy.statusCode).toBe(201);
    const rows = await t.sql`select email, status, date_of_birth::text as dob, social_media, stage_name, bio from public.celebrity_applications order by created_at`;
    expect(rows).toEqual([
      { email: 'kiran@example.com', status: 'pending', dob: '1990-01-02', social_media: { instagram: '@km' }, stage_name: 'KM', bio: 'b' },
      { email: 'alice.acc@example.com', status: 'pending', dob: '1991-05-06', social_media: { instagram: '@a' }, stage_name: '', bio: '' },
    ]);
    const again = await t.app.inject({ method: 'POST', url: '/rest/v1/celebrity_applications', headers: anon(), payload: { first_name: 'K', email: 'kiran@example.com', phone: '9000000300' } });
    expect(again.statusCode).toBe(201);
    expect(await t.sql`select id from public.celebrity_applications where email = 'kiran@example.com'`).toHaveLength(1);
    const status = await get(`/rest/v1/celebrity_applications?select=id,status&email=eq.${encodeURIComponent('kiran@example.com')}&limit=1`, anon());
    expect(status.statusCode).toBe(200);
    expect(Object.keys(status.json()[0]).sort()).toEqual(['id', 'status']);
    expect(status.json()[0].status).toBe('pending');
    const none = await get(`/rest/v1/celebrity_applications?select=id,status&email=eq.nobody%40example.com&limit=1`, anon());
    expect(none.json()).toEqual([]);
    const wide = await get('/rest/v1/celebrity_applications?select=*', anon());
    expect(wide.statusCode).toBe(403);
  });
});

describe('referral RPCs', () => {
  it('validates codes anonymously and lists my referrals and history', async () => {
    const code = (await t.sql<{ c: string }[]>`select referral_code as c from public.profiles where id = ${aliceProfile}`)[0]!.c;
    const ok = await t.app.inject({ method: 'POST', url: '/rest/v1/rpc/validate_referral_code', headers: anon(), payload: { p_code: ` ${code.toLowerCase()} ` } });
    expect(ok.json()).toBe('Alicia');
    const bad = await t.app.inject({ method: 'POST', url: '/rest/v1/rpc/validate_referral_code', headers: anon(), payload: { p_code: 'ZZZZ9999' } });
    expect(bad.json()).toBeNull();

    await t.sql`update public.profiles set referred_by = ${aliceProfile} where id = ${bobProfile}`;
    const mine = await t.app.inject({ method: 'POST', url: '/rest/v1/rpc/get_my_referrals', headers: bearer(alice.access_token), payload: {} });
    expect(mine.json()).toHaveLength(1);
    const history = await t.app.inject({ method: 'POST', url: '/rest/v1/rpc/get_my_referral_history', headers: bearer(alice.access_token), payload: {} });
    expect(history.json()).toEqual([
      expect.objectContaining({ commission_level: 1, commission_amount: 25, status: 'completed', order_type: 'ugc_video', referred_name: 'Bob D.' }),
    ]);
    const anonHistory = await t.app.inject({ method: 'POST', url: '/rest/v1/rpc/get_my_referral_history', headers: anon(), payload: {} });
    expect(anonHistory.statusCode).toBe(401);
  });
});

describe('realtime rule', () => {
  it('allows only the own profile id', async () => {
    const rule = t.deps.policies.table('profiles')!.realtime!;
    const auth = await t.deps.resolver.resolve(alice.access_token);
    const identity = await auth.identity();
    expect(await rule.authorize(auth, identity, 'id', aliceProfile, t.deps)).toBe(true);
    expect(await rule.authorize(auth, identity, 'id', bobProfile, t.deps)).toBe(false);
  });
});
