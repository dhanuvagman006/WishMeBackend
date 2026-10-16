/**
 * Celebrity bookings and subscriptions: server-side pricing, the single "create booking and pay" transaction, the
 * mirror contract with the app's follow-up money rows, celebrity status transitions with refunds, reviews, the
 * purchase_celebrity_subscription RPC (wallet and Razorpay) and the Razorpay purpose.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePolicy } from '../../src/compat/postgrest/policy.js';
import { rpcs, tables } from '../../src/compat/postgrest/policies/celebrities.js';
import { quoteBooking } from '../../src/domains/celebrities/bookings.js';
import { subscriptionPurpose } from '../../src/domains/payments/purposes/celebrities.js';
import type { OrderRow } from '../../src/domains/payments/service.js';
import { claimMirror } from '../../src/domains/wallet/mirrors.js';
import { sql } from '../../src/lib/sql.js';
import { bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

// Embeds of profiles need a profiles policy; the real one lives in accounts.ts (another domain).
const profilesForEmbeds = definePolicy({
  table: 'profiles',
  read: [
    { name: 'owner', rows: (c) => (c.identity.profileId ? sql`${c.col('id')} = ${c.identity.profileId}::uuid` : 'none'), columns: '*' },
    { name: 'names', rows: (c) => (c.auth.kind === 'anon' ? 'none' : 'all'), columns: ['id', 'first_name', 'last_name'] },
  ],
});

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;
let carol: TestSession;
let aliceP: string;
let bobP: string;
let carolP: string;
let celebId: string;
let otherCelebId: string;

const balanceOf = async (pid: string) => Number((await t.sql<{ b: string }[]>`select wallet_balance::text as b from public.profiles where id = ${pid}`)[0]!.b);
const post = (token: string, url: string, payload: unknown, prefer = 'return=representation') =>
  t.app.inject({ method: 'POST', url, headers: { ...bearer(token), prefer }, payload: payload as Record<string, unknown> });
const patch = (token: string, url: string, payload: unknown) => t.app.inject({ method: 'PATCH', url, headers: { ...bearer(token), prefer: 'return=minimal' }, payload: payload as Record<string, unknown> });
const rpc = (token: string, args: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/rest/v1/rpc/purchase_celebrity_subscription', headers: bearer(token), payload: args });

function wishBody(celebrity: string, finalPrice: number, extra: Record<string, unknown> = {}) {
  return {
    celebrity_id: celebrity,
    user_id: aliceP,
    service_type: 'video_wish',
    original_price: finalPrice,
    discount_amount: 0,
    final_price: finalPrice,
    status: 'pending',
    message: JSON.stringify({ serviceType: 'wish', requestDetails: { recipientName: 'Mom', occasion: 'Birthday', n: Math.random() } }),
    instructions: 'Make it warm',
    delivery_type: 'video',
    generated_prompt: 'Happy birthday!',
    ...extra,
  };
}

beforeAll(async () => {
  // The real update_wallet_balance trigger: the ledger must end at the right balance with it in place.
  t = await bootTest({ policies: [...tables, profilesForEmbeds], rpcs, extraFixtures: ['balance-trigger.sql'] });
  alice = await signUp(t, 'alice-b@example.com', undefined, { first_name: 'Alice', last_name: 'A', phone: '9000000011' });
  bob = await signUp(t, 'bob-b@example.com', undefined, { first_name: 'Bob', last_name: 'B', phone: '9000000012' });
  carol = await signUp(t, 'carol-b@example.com', undefined, { first_name: 'Carol', last_name: 'C', phone: '9000000013' });
  aliceP = await profileIdOf(t, alice.user.id);
  bobP = await profileIdOf(t, bob.user.id);
  carolP = await profileIdOf(t, carol.user.id);
  await t.sql`update public.profiles set wallet_balance = 5000 where id in (${aliceP}, ${carolP})`;
  const c = await t.sql<{ id: string }[]>`
    insert into public.celebrities (profile_id, name, category, service_prices)
    values (${bobP}, 'Bob Star', 'Singer', ${t.sql.json({ general_wish: 1000, ugc_ad: 0 })}) returning id`;
  celebId = c[0]!.id;
  const o = await t.sql<{ id: string }[]>`insert into public.celebrities (name, category) values ('Other Star', 'Actor') returning id`;
  otherCelebId = o[0]!.id;
  await t.sql`insert into public.celebrity_favorite_pricing (celebrity_id, price, referrer_commission_percentage, celebrity_commission_percentage)
              values (${celebId}, 499, 10, 50), (${otherCelebId}, 299, 0, 40)`;
});
afterAll(async () => {
  await t.close();
});

describe('pricing', () => {
  it('matches the app: base price, 10 % fee rounded half up, defaults and refusals', () => {
    expect(quoteBooking('video_wish', { general_wish: 1000 })).toEqual({ baseRupees: 1000, discountRupees: 0, feeRupees: 100, finalRupees: 1100 });
    expect(quoteBooking('video_wish', { general_wish: 1505 }).finalRupees).toBe(1505 + 151);
    expect(quoteBooking('video_wish', {}).finalRupees).toBe(1650);
    expect(quoteBooking('video_promotion', null).finalRupees).toBe(55000);
    expect(() => quoteBooking('image_promotion', { ugc_ad: 0 })).toThrow(/not available/);
    expect(() => quoteBooking('video_wish', { general_wish: 99.5 })).toThrow(/not available/);
  });
});

describe('purchase_celebrity_subscription (wallet)', () => {
  it('refuses a wish booking before subscribing', async () => {
    const res = await post(alice.access_token, '/rest/v1/bookings', wishBody(celebId, 1100));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('You must subscribe to this celebrity to book');
  });

  it('refuses a price the server does not charge, with production words', async () => {
    const res = await rpc(alice.access_token, { p_celebrity_id: celebId, p_price: 1, p_payment_method: 'wallet' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, message: 'Price mismatch. Expected 499, got 1' });
    expect(await balanceOf(aliceP)).toBe(5000);
  });

  it('debits the server price once, activates the subscription and answers { success: true }', async () => {
    const res = await rpc(alice.access_token, { p_celebrity_id: celebId, p_price: 499, p_payment_method: 'wallet' });
    expect(res.statusCode).toBe(200);
    // 499 at 50 %: celebrity gross 249, TDS 20 % (PAN not verified) 49, net 200, platform fee 250; referrer 10 % = 49.
    expect(res.json()).toMatchObject({ success: true, celebrity_commission: 200, platform_fee: 250, new_balance: 4501 });
    expect(await balanceOf(aliceP)).toBe(4501);
    const fav = await t.sql`select status, price_paid, celebrity_commission, referrer_commission, payment_method from public.celebrity_favorites where user_id = ${aliceP}`;
    expect(fav[0]).toEqual({ status: 'active', price_paid: 499, celebrity_commission: 249, referrer_commission: 49, payment_method: 'wallet' });
    const hist = await t.sql`select transaction_type, amount from public.wallet_transactions where user_id = ${aliceP}`;
    expect(hist).toEqual([{ transaction_type: 'celebrity_subscription', amount: 499 }]);
    const celeb = await t.sql`select available_balance, total_earnings from public.celebrities where id = ${celebId}`;
    expect(celeb[0]).toEqual({ available_balance: 200, total_earnings: 200 });
    const earning = await t.sql`select transaction_type, order_type, amount, gross_amount, tds_amount, status from public.celebrity_wallet_transactions where celebrity_id = ${celebId}`;
    expect(earning).toEqual([{ transaction_type: 'earning', order_type: 'subscription', amount: 200, gross_amount: 249, tds_amount: 49, status: 'completed' }]);
  });

  it('rejects a second purchase with words SubscribeSheet recognises, without charging', async () => {
    const res = await rpc(alice.access_token, { p_celebrity_id: celebId, p_price: 499, p_payment_method: 'wallet' });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/already subscribed/i);
    expect(await balanceOf(aliceP)).toBe(4501);
  });

  it('requires a session', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/rest/v1/rpc/purchase_celebrity_subscription', headers: { apikey: 'test-anon-key' }, payload: { p_celebrity_id: celebId } });
    expect(res.statusCode).toBe(401);
  });
});

let bookingId: string;

describe('POST /rest/v1/bookings', () => {
  it('creates the booking and debits the wallet in one step, returning the row', async () => {
    const res = await post(alice.access_token, '/rest/v1/bookings', wishBody(celebId, 1100));
    expect(res.statusCode).toBe(201);
    const rows = res.json();
    expect(rows).toHaveLength(1);
    bookingId = rows[0].id;
    expect(rows[0]).toMatchObject({ status: 'pending', final_price: 1100, original_price: 1000, service_type: 'video_wish', user_id: aliceP, celebrity_id: celebId });
    expect(await balanceOf(aliceP)).toBe(3401);
    const ledger = await t.sql`select kind, amount_paise::text, reference_type, reference_id, metadata from wishme.ledger_entries where idempotency_key = ${`booking:${bookingId}:debit`}`;
    expect(ledger[0]).toMatchObject({ kind: 'withdrawal', amount_paise: '-110000', reference_type: 'booking', reference_id: bookingId });
    expect(ledger[0]!.metadata).toMatchObject({ mirrorable: true, service_type: 'booking', order_id: bookingId });
  });

  it("lets the accounts domain answer the app's follow-up rows as mirrors of this debit", async () => {
    const wallet = await claimMirror(t.deps.db, { accountId: aliceP, absAmountPaise: 110000, kinds: ['withdrawal'], table: 'wallet_transactions' });
    expect(wallet?.referenceId).toBe(bookingId);
    const payment = await claimMirror(t.deps.db, { accountId: aliceP, absAmountPaise: 110000, kinds: ['withdrawal', 'booking'], table: 'payment_transactions', referenceId: bookingId });
    expect(payment?.referenceId).toBe(bookingId);
    const again = await claimMirror(t.deps.db, { accountId: aliceP, absAmountPaise: 110000, kinds: ['withdrawal'], table: 'wallet_transactions' });
    expect(again).toBeNull();
  });

  it('treats an identical retry as the same booking (double tap)', async () => {
    const body = wishBody(celebId, 1100, { message: 'same' });
    const a = await post(alice.access_token, '/rest/v1/bookings', body);
    const b = await post(alice.access_token, '/rest/v1/bookings', body);
    expect(a.json()[0].id).toBe(b.json()[0].id);
    expect(await balanceOf(aliceP)).toBe(2301);
  });

  it('refuses a price that differs from the server price', async () => {
    const res = await post(alice.access_token, '/rest/v1/bookings', wishBody(celebId, 10));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('price_changed');
  });

  it('refuses services the celebrity does not offer, other users and server columns', async () => {
    const ad = await post(alice.access_token, '/rest/v1/bookings', { ...wishBody(celebId, 0), service_type: 'image_promotion', final_price: undefined });
    expect(ad.statusCode).toBe(400);
    const other = await post(alice.access_token, '/rest/v1/bookings', wishBody(celebId, 1100, { user_id: carolP }));
    expect(other.statusCode).toBe(403);
    const col = await post(alice.access_token, '/rest/v1/bookings', wishBody(celebId, 1100, { payment_status: 'paid' }));
    expect(col.statusCode).toBe(403);
  });

  it('answers "Insufficient wallet balance" and leaves no booking behind', async () => {
    const before = (await t.sql`select count(*)::int as n from public.bookings`)[0]!.n;
    const res = await post(alice.access_token, '/rest/v1/bookings', { ...wishBody(celebId, 55000), service_type: 'video_promotion' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Insufficient wallet balance');
    expect((await t.sql`select count(*)::int as n from public.bookings`)[0]!.n).toBe(before);
    expect(await balanceOf(aliceP)).toBe(2301);
  });
});

describe('reading and updating bookings', () => {
  it('shows the user their bookings, the celebrity theirs with the fan name, and nobody else anything', async () => {
    const mine = await t.app.inject({ method: 'GET', url: `/rest/v1/bookings?id=eq.${bookingId}&select=*,celebrities(name,image_url,category)&limit=1`, headers: bearer(alice.access_token) });
    expect(mine.json()[0].celebrities).toEqual({ name: 'Bob Star', image_url: null, category: 'Singer' });
    const dash = await t.app.inject({
      method: 'GET',
      url: `/rest/v1/bookings?celebrity_id=eq.${celebId}&select=*,profiles(first_name,last_name)&order=created_at.desc&limit=50`,
      headers: bearer(bob.access_token),
    });
    expect(dash.json().length).toBe(2);
    expect(dash.json()[0].profiles).toEqual({ first_name: 'Alice', last_name: 'A' });
    const none = await t.app.inject({ method: 'GET', url: '/rest/v1/bookings?select=id', headers: bearer(carol.access_token) });
    expect(none.json()).toEqual([]);
  });

  it('lets the user stamp a display payment id once', async () => {
    expect((await patch(alice.access_token, `/rest/v1/bookings?id=eq.${bookingId}`, { wishme_payment_id: 'WMABC123' })).statusCode).toBe(204);
    await patch(alice.access_token, `/rest/v1/bookings?id=eq.${bookingId}`, { wishme_payment_id: 'WMZZZ999' });
    const row = await t.sql`select wishme_payment_id from public.bookings where id = ${bookingId}`;
    expect(row[0]!.wishme_payment_id).toBe('WMABC123');
  });

  it('does not let the user change status or price', async () => {
    expect((await patch(alice.access_token, `/rest/v1/bookings?id=eq.${bookingId}`, { status: 'completed' })).statusCode).toBe(204);
    expect((await patch(alice.access_token, `/rest/v1/bookings?id=eq.${bookingId}`, { final_price: 1 })).statusCode).toBe(403);
    const row = await t.sql`select status::text, final_price from public.bookings where id = ${bookingId}`;
    expect(row[0]).toEqual({ status: 'pending', final_price: 1100 });
  });

  it('refunds the user once when the celebrity declines ("rejected" is stored as the enum\'s "cancelled")', async () => {
    expect((await patch(bob.access_token, `/rest/v1/bookings?id=eq.${bookingId}`, { status: 'rejected' })).statusCode).toBe(204);
    expect((await t.sql`select status::text from public.bookings where id = ${bookingId}`)[0]!.status).toBe('cancelled');
    expect(await balanceOf(aliceP)).toBe(3401);
    await patch(bob.access_token, `/rest/v1/bookings?id=eq.${bookingId}`, { status: 'rejected' });
    expect(await balanceOf(aliceP)).toBe(3401);
    const refunds = await t.sql`select count(*)::int as n from wishme.ledger_entries where idempotency_key = ${`booking:${bookingId}:refund`}`;
    expect(refunds[0]!.n).toBe(1);
  });

  it('enforces transitions and lets the user review a completed booking once', async () => {
    const res = await post(alice.access_token, '/rest/v1/bookings', wishBody(celebId, 1100));
    const id = res.json()[0].id as string;
    const early = await post(alice.access_token, '/rest/v1/celebrity_reviews', { booking_id: id, rating: 5, comment: 'Great' });
    expect(early.statusCode).toBe(400);
    expect((await patch(bob.access_token, `/rest/v1/bookings?id=eq.${id}`, { status: 'completed' })).statusCode).toBe(400);
    expect((await patch(bob.access_token, `/rest/v1/bookings?id=eq.${id}`, { status: 'accepted' })).statusCode).toBe(204);
    expect((await t.sql`select status::text from public.bookings where id = ${id}`)[0]!.status).toBe('confirmed');
    expect((await patch(bob.access_token, `/rest/v1/bookings?id=eq.${id}`, { status: 'completed' })).statusCode).toBe(204);
    expect((await patch(bob.access_token, `/rest/v1/bookings?id=eq.${id}`, { status: 'accepted' })).statusCode).toBe(400);

    const notMine = await post(carol.access_token, '/rest/v1/celebrity_reviews', { booking_id: id, rating: 1 });
    expect(notMine.statusCode).toBe(403);
    const review = await post(alice.access_token, '/rest/v1/celebrity_reviews', { booking_id: id, rating: 4, comment: 'Lovely' });
    expect(review.statusCode).toBe(201);
    expect(review.json()[0]).toMatchObject({ rating: 4, review_text: 'Lovely', user_id: aliceP });
    const dup = await post(alice.access_token, '/rest/v1/celebrity_reviews', { booking_id: id, rating: 5 });
    expect(dup.statusCode).toBe(409);
    const pub = await t.app.inject({ method: 'GET', url: `/rest/v1/celebrity_reviews?celebrity_id=eq.${celebId}&select=*`, headers: { apikey: 'test-anon-key' } });
    expect(pub.json()[0]).toMatchObject({ rating: 4, user_id: null });
  });

  it('authorises realtime filters on own ids only', () => {
    const rule = tables.find((p) => p.table === 'bookings')!.realtime!;
    const identity = { profileId: aliceP, celebrityIds: [], profileRole: 'user' };
    const auth = {} as never;
    expect(rule.authorize(auth, identity, 'user_id', aliceP, t.deps)).toBe(true);
    expect(rule.authorize(auth, identity, 'user_id', bobP, t.deps)).toBe(false);
    expect(rule.authorize(auth, { ...identity, celebrityIds: [celebId] }, 'celebrity_id', celebId, t.deps)).toBe(true);
    expect(rule.authorize(auth, identity, 'celebrity_id', celebId, t.deps)).toBe(false);
  });
});

describe('Razorpay subscriptions', () => {
  it('prices the order server-side and refuses an existing subscriber', async () => {
    const purpose = subscriptionPurpose(t.deps);
    const auth = {} as never;
    await expect(purpose.price({ auth, identity: { profileId: carolP, celebrityIds: [], profileRole: 'user' }, body: { amount: 1 }, notes: { celebrity_id: otherCelebId } })).resolves.toBe(29900);
    await expect(purpose.price({ auth, identity: { profileId: aliceP, celebrityIds: [], profileRole: 'user' }, body: {}, notes: { celebrity_id: celebId } })).rejects.toThrow(/already subscribed/);
  });

  it('reports "no payment" to the RPC when nothing was paid', async () => {
    const res = await rpc(carol.access_token, { p_celebrity_id: otherCelebId, p_price: 299, p_payment_method: 'razorpay' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, code: 'payment_not_found' });
  });

  it('activates on fulfilment (idempotently) and the RPC then confirms it', async () => {
    await t.sql`insert into wishme.payment_orders (razorpay_order_id, user_id, profile_id, purpose, amount_paise, notes)
                values ('order_test_1', ${carol.user.id}, ${carolP}, 'celebrity_favorite', 29900, ${t.sql.json({ type: 'celebrity_favorite', celebrity_id: otherCelebId })})`;
    const order = (await t.sql<OrderRow[]>`select * from wishme.payment_orders where razorpay_order_id = 'order_test_1'`)[0]!;
    const payment = { id: 'pay_test_1', order_id: 'order_test_1', amount: 29900, currency: 'INR', status: 'captured' as const };
    const first = await t.deps.payments.fulfil(order, 'pay_test_1', payment);
    expect(first).toMatchObject({ success: true, celebrity_id: otherCelebId });
    const again = await t.deps.payments.fulfil(order, 'pay_test_1', payment);
    expect(again.wishme_payment_id).toBe(first.wishme_payment_id);
    const fav = await t.sql`select status, price_paid, payment_method from public.celebrity_favorites where user_id = ${carolP}`;
    expect(fav).toEqual([{ status: 'active', price_paid: 299, payment_method: 'razorpay' }]);
    // Record-only: the history row exists (the balance trigger debits it) and the ledger puts the balance back.
    expect(await balanceOf(carolP)).toBe(5000);
    // 299 × 40 % = 119 gross, 20 % TDS = 23, net 96 to the celebrity, once.
    expect((await t.sql`select available_balance from public.celebrities where id = ${otherCelebId}`)[0]!.available_balance).toBe(96);
    const res = await rpc(carol.access_token, { p_celebrity_id: otherCelebId, p_price: 299, p_payment_method: 'razorpay' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, payment_method: 'razorpay' });
  });
});
