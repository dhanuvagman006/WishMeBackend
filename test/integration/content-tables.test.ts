/**
 * Content domain on /rest/v1: wish orders (server price, payment proof before "paid", the app's rollback delete),
 * the two order RPCs (server price + ledger debit in one transaction), library items, generation history rows and
 * the Razorpay wish-order purpose. Razorpay's API is stubbed; nothing leaves the machine.
 */
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveWishOrderDebit, wishOrderIdFromDescription } from '../../src/domains/content/wish-orders.js';
import { bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

const KEY_ID = 'rzp_test_key';
const KEY_SECRET = 'rzp_test_secret_0123456789';

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;
let star: TestSession;
let aliceProfile: string;
let bobProfile: string;
let celebId: string;
let otherCelebId: string;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
const rzpPayments = new Map<string, { id: string; order_id: string; amount: number; currency: string; status: string }>();
let rzpSeq = 0;

function stubRazorpay() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.razorpay.com/')) return realFetch(input, init);
    if (url.endsWith('/v1/orders') && init?.method === 'POST') {
      const b = JSON.parse(String(init.body)) as { amount: number; currency: string; receipt: string; notes: Record<string, string> };
      return json(200, { id: `order_c${++rzpSeq}`, entity: 'order', amount: b.amount, currency: b.currency, receipt: b.receipt, status: 'created', notes: b.notes });
    }
    const pay = /\/v1\/payments\/([^/]+)$/.exec(url);
    if (pay) {
      const p = rzpPayments.get(decodeURIComponent(pay[1]!));
      return p ? json(200, p) : json(404, {});
    }
    return json(404, {});
  });
}

const balance = async (profileId = aliceProfile) => Number((await t.sql`select wallet_balance from public.profiles where id = ${profileId}`)[0]!.wallet_balance);
const setBalance = (rupees: number, profileId = aliceProfile) => t.sql`update public.profiles set wallet_balance = ${rupees} where id = ${profileId}`;
const uploadUrl = (folder: string, profileId: string) => `${t.env.PUBLIC_URL}/storage/v1/object/public/greeting-card-uploads/${folder}/${profileId}-1700000000.jpg`;
const rest = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, s: TestSession, payload?: unknown, prefer?: string) =>
  t.app.inject({ method, url, headers: { ...bearer(s.access_token), ...(prefer ? { prefer } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function createOrder(s: TestSession, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await rest(
    'POST',
    '/rest/v1/wish_celebrity_orders',
    s,
    {
      user_id: 'ignored',
      celebrity_id: celebId,
      occasion_type: 'Birthday',
      recipient_name: 'Asha',
      message: 'Many happy returns!',
      card_prompt: 'Gold balloons',
      card_generation_type: 'ai',
      amount_paid: 1,
      discount_percentage: 0,
      discount_amount: 0,
      payment_method: 'wallet',
      payment_status: 'completed',
      status: 'pending',
      ...extra,
    },
    'return=representation',
  );
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as Array<{ id: string }>)[0]!.id;
}

beforeAll(async () => {
  t = await bootTest({
    extraFixtures: ['balance-trigger.sql'],
    env: { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: 'whsec_0123456789abcdef' },
  });
  alice = await signUp(t, 'alice-content@example.com');
  bob = await signUp(t, 'bob-content@example.com');
  star = await signUp(t, 'star-content@example.com');
  aliceProfile = await profileIdOf(t, alice.user.id);
  bobProfile = await profileIdOf(t, bob.user.id);
  const starProfile = await profileIdOf(t, star.user.id);
  const c = await t.sql<{ id: string }[]>`
    insert into public.celebrities (profile_id, name, category, service_prices, is_active)
    values (${starProfile}, 'Star One', 'Singer', ${t.sql.json({ general_wish: 500, ugc_ad: 800 })}, true) returning id`;
  celebId = c[0]!.id;
  const o = await t.sql<{ id: string }[]>`
    insert into public.celebrities (name, category, service_prices, is_active) values ('No Price', 'Actor', '{}'::jsonb, true) returning id`;
  otherCelebId = o[0]!.id;
  await t.sql`insert into public.plans (name, price, service_discount_percentage) values ('premium', 999, 10)`;
  await t.sql`insert into public.platform_settings (setting_key, setting_value) values ('ugc_video_price', '500'), ('ugc_ads_price', '999')`;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => t.close());

describe('wish_celebrity_orders', () => {
  it('creates the order at the server price, ignoring the client amount and payment status', async () => {
    const id = await createOrder(alice);
    const row = (await t.sql`select user_id, amount_paid, payment_status, status from public.wish_celebrity_orders where id = ${id}`)[0]!;
    expect(row).toMatchObject({ user_id: aliceProfile, amount_paid: 500, payment_status: 'pending', status: 'pending' });
  });

  it('refuses upload URLs that are not the caller\'s own files, unknown columns and unpriced celebrities', async () => {
    const foreign = await rest('POST', '/rest/v1/wish_celebrity_orders', alice, {
      celebrity_id: celebId, occasion_type: 'Birthday', recipient_name: 'A', message: 'Hi', card_generation_type: 'upload-card',
      user_uploaded_card_url: uploadUrl('user-cards', bobProfile),
    });
    expect(foreign.statusCode).toBe(400);
    const column = await rest('POST', '/rest/v1/wish_celebrity_orders', alice, {
      celebrity_id: celebId, occasion_type: 'Birthday', recipient_name: 'A', message: 'Hi', card_prompt: 'x', generated_card_image_url: 'https://x',
    });
    expect(column.statusCode).toBe(403);
    const unpriced = await rest('POST', '/rest/v1/wish_celebrity_orders', alice, {
      celebrity_id: otherCelebId, occasion_type: 'Birthday', recipient_name: 'A', message: 'Hi', card_prompt: 'x',
    });
    expect(unpriced.statusCode).toBe(400);
  });

  it('refuses "paid" without proof, accepts it once the wallet debit referencing the order covers the price', async () => {
    const id = await createOrder(alice);
    const early = await rest('PATCH', `/rest/v1/wish_celebrity_orders?id=eq.${id}`, alice, { status: 'paid', payment_status: 'completed', payment_method: 'wallet' }, 'return=minimal');
    expect(early.statusCode).toBe(403);

    await setBalance(1000);
    // What the wallet_transactions handler does with the app's debit row (reference_id = order id).
    await t.deps.ledger.run('user_wallet', { accountId: aliceProfile, deltaPaise: -10_000, kind: 'greeting_card_generation', idempotencyKey: `t:short:${id}`, createdBy: 'test', reference: { type: 'wish_celebrity_order', id } });
    const short = await rest('PATCH', `/rest/v1/wish_celebrity_orders?id=eq.${id}`, alice, { status: 'paid', payment_status: 'completed', payment_method: 'wallet' });
    expect(short.statusCode).toBe(403);

    await t.deps.ledger.run('user_wallet', { accountId: aliceProfile, deltaPaise: -40_000, kind: 'greeting_card_generation', idempotencyKey: `t:rest:${id}`, createdBy: 'test', reference: { type: 'wish_celebrity_order', id } });
    const ok = await rest('PATCH', `/rest/v1/wish_celebrity_orders?id=eq.${id}`, alice, { status: 'paid', payment_status: 'completed', payment_method: 'wallet' }, 'return=minimal');
    expect(ok.statusCode).toBe(204);
    const row = (await t.sql`select payment_status, status, payment_method from public.wish_celebrity_orders where id = ${id}`)[0]!;
    // status cannot hold 'paid' (CHECK pending|generated|sent|failed): payment lives in payment_status.
    expect(row).toMatchObject({ payment_status: 'completed', status: 'pending', payment_method: 'wallet' });
    expect(await resolveWishOrderDebit(t.deps.db, aliceProfile, id)).toEqual({ kind: 'already_paid', orderId: id });
  });

  it('tells the wallet handler the server price for an unpaid order and parses the id from the app\'s description', async () => {
    const id = await createOrder(alice);
    expect(await resolveWishOrderDebit(t.deps.db, aliceProfile, id)).toMatchObject({ kind: 'charge', amountPaise: 50_000 });
    expect(await resolveWishOrderDebit(t.deps.db, bobProfile, id)).toEqual({ kind: 'not_wish_order' });
    expect(wishOrderIdFromDescription(`Wish order #${id} for Star One - Birthday`)).toBe(id);
  });

  it('lets the owner mark a paid upload order sent, never an AI order or an unpaid one', async () => {
    const ai = await createOrder(alice);
    expect((await rest('PATCH', `/rest/v1/wish_celebrity_orders?id=eq.${ai}`, alice, { status: 'sent' })).statusCode).toBe(403);
    const upload = await createOrder(alice, { card_generation_type: 'upload-card', card_prompt: null, user_uploaded_card_url: uploadUrl('user-cards', aliceProfile) });
    expect((await rest('PATCH', `/rest/v1/wish_celebrity_orders?id=eq.${upload}`, alice, { status: 'sent' })).statusCode).toBe(403);
    await t.sql`update public.wish_celebrity_orders set payment_status = 'completed' where id = ${upload}`;
    expect((await rest('PATCH', `/rest/v1/wish_celebrity_orders?id=eq.${upload}`, alice, { status: 'sent' })).statusCode).toBe(204);
    expect((await t.sql`select status from public.wish_celebrity_orders where id = ${upload}`)[0]!.status).toBe('sent');
  });

  it('deletes only the caller\'s unpaid orders (the app\'s rollback)', async () => {
    const unpaid = await createOrder(alice);
    expect((await rest('DELETE', `/rest/v1/wish_celebrity_orders?id=eq.${unpaid}`, bob)).statusCode).toBe(204);
    expect((await t.sql`select count(*)::int as n from public.wish_celebrity_orders where id = ${unpaid}`)[0]!.n).toBe(1);
    expect((await rest('DELETE', `/rest/v1/wish_celebrity_orders?id=eq.${unpaid}`, alice)).statusCode).toBe(204);
    expect((await t.sql`select count(*)::int as n from public.wish_celebrity_orders where id = ${unpaid}`)[0]!.n).toBe(0);
    const paid = await createOrder(alice);
    await t.sql`update public.wish_celebrity_orders set payment_status = 'completed' where id = ${paid}`;
    await rest('DELETE', `/rest/v1/wish_celebrity_orders?id=eq.${paid}`, alice);
    expect((await t.sql`select count(*)::int as n from public.wish_celebrity_orders where id = ${paid}`)[0]!.n).toBe(1);
  });

  it('shows orders to their owner and, with fewer columns, to the celebrity they are addressed to', async () => {
    const id = await createOrder(alice);
    const own = await rest('GET', `/rest/v1/wish_celebrity_orders?id=eq.${id}&select=*&limit=1`, alice);
    expect(own.json()[0]).toMatchObject({ id, amount_paid: 500, message: 'Many happy returns!' });
    expect((await rest('GET', `/rest/v1/wish_celebrity_orders?id=eq.${id}`, bob)).json()).toEqual([]);
    await t.deps.resolver.forgetIdentity(star.user.id);
    const celeb = await rest('GET', `/rest/v1/wish_celebrity_orders?id=eq.${id}&select=id,message,amount_paid,user_id`, star);
    expect(celeb.json()).toEqual([{ id, message: 'Many happy returns!', amount_paid: null, user_id: null }]);
    const hack = await rest('PATCH', `/rest/v1/wish_celebrity_orders?id=eq.${id}`, bob, { payment_status: 'completed' });
    expect(hack.statusCode).toBe(204);
    expect((await t.sql`select payment_status from public.wish_celebrity_orders where id = ${id}`)[0]!.payment_status).toBe('pending');
  });

  it('charges the wallet debit the app writes for a wish order at the server price, once', async () => {
    const id = await createOrder(alice);
    await setBalance(2000);
    const debit = (amount: number) =>
      rest('POST', '/rest/v1/wallet_transactions', alice, {
        user_id: aliceProfile,
        transaction_type: 'booking',
        amount,
        description: `Wish order #${id} for Star One - Birthday`,
        status: 'completed',
      });
    const first = await debit(-1);
    expect(first.statusCode, first.body).toBe(201);
    expect(await balance()).toBe(1500);
    // The order is now provably paid, so the app's follow-up PATCH succeeds.
    expect((await rest('PATCH', `/rest/v1/wish_celebrity_orders?id=eq.${id}`, alice, { status: 'paid', payment_status: 'completed', payment_method: 'wallet' })).statusCode).toBe(204);
    const second = await debit(-500);
    expect(second.statusCode).toBe(409);
    expect(await balance()).toBe(1500);
  });

  it('prices a typeless wish checkout (WISH- receipt) as the wish, not as a deposit, and links the payment record', async () => {
    stubRazorpay();
    const id = await createOrder(alice, { payment_method: 'razorpay', payment_status: 'pending' });
    const created = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/create-razorpay-order',
      headers: bearer(alice.access_token),
      payload: { amount: 100, currency: 'INR', receipt: `WISH-${id}`.slice(0, 40), notes: { orderId: id } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const order = created.json() as { id: string; amount: number };
    expect(order.amount).toBe(50_000);
    rzpPayments.set('pay_wish_typeless', { id: 'pay_wish_typeless', order_id: order.id, amount: order.amount, currency: 'INR', status: 'captured' });
    const signature = createHmac('sha256', KEY_SECRET).update(`${order.id}|pay_wish_typeless`).digest('hex');
    const verify = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/verify-razorpay-payment',
      headers: bearer(alice.access_token),
      payload: { razorpay_order_id: order.id, razorpay_payment_id: 'pay_wish_typeless', razorpay_signature: signature, orderId: id, orderType: 'wish' },
    });
    expect(verify.statusCode, verify.body).toBe(200);
    const rec = (await t.sql`select wish_order_id::text, service_type from public.payment_transactions where razorpay_payment_id = 'pay_wish_typeless'`)[0]!;
    expect(rec).toMatchObject({ wish_order_id: id, service_type: 'wish_order' });
  });

  it('prices a Razorpay wish payment on the server and marks the order paid on fulfilment', async () => {
    stubRazorpay();
    const id = await createOrder(alice, { payment_method: 'razorpay', payment_status: 'pending' });
    const created = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/create-razorpay-order',
      headers: bearer(alice.access_token),
      payload: { amount: 100, currency: 'INR', receipt: `WISH-${id}`.slice(0, 40), notes: { type: 'wish_order', orderId: id } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const order = created.json() as { id: string; amount: number };
    expect(order.amount).toBe(50_000);
    rzpPayments.set('pay_wish_1', { id: 'pay_wish_1', order_id: order.id, amount: order.amount, currency: 'INR', status: 'captured' });
    const signature = createHmac('sha256', KEY_SECRET).update(`${order.id}|pay_wish_1`).digest('hex');
    const verify = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/verify-razorpay-payment',
      headers: bearer(alice.access_token),
      payload: { razorpay_order_id: order.id, razorpay_payment_id: 'pay_wish_1', razorpay_signature: signature, orderId: id, orderType: 'wish' },
    });
    expect(verify.statusCode, verify.body).toBe(200);
    const row = (await t.sql`select payment_status, payment_method, razorpay_payment_id, wishme_payment_id from public.wish_celebrity_orders where id = ${id}`)[0]!;
    expect(row).toMatchObject({ payment_status: 'completed', payment_method: 'razorpay', razorpay_payment_id: 'pay_wish_1' });
    expect(row.wishme_payment_id).toMatch(/^WM\d{14}$/);
    // The app's follow-up PATCH is now a harmless no-op.
    expect((await rest('PATCH', `/rest/v1/wish_celebrity_orders?id=eq.${id}`, alice, { status: 'paid', payment_status: 'completed', payment_method: 'razorpay' })).statusCode).toBe(204);
    const again = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/create-razorpay-order',
      headers: bearer(alice.access_token),
      payload: { amount: 100, notes: { type: 'wish_order', orderId: id } },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('order RPCs', () => {
  it('create_wish_friend_order prices with the plan discount, debits the wallet and returns the row', async () => {
    await t.sql`update public.profiles set plan = 'premium' where id = ${aliceProfile}`;
    await setBalance(2000);
    const res = await rest('POST', '/rest/v1/rpc/create_wish_friend_order', alice, {
      p_order_type: 'ugc_video', p_celebrity_id: celebId, p_recipient_name: 'Mom', p_occasion: 'Birthday', p_relationship: '', p_tone: 'Warm',
      p_prompt: 'A lovely birthday message', p_aspect_ratio: '9:16', p_hook_style: '', p_call_to_action: '', p_reference_image_url: '',
      p_details: { photos: [] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const order = res.json() as { id: string; price_paid: number; original_price: number; discount_amount: number; user_id: string; relationship: string | null };
    // ugc_ad 800 with 10 % off = 720 (Math.round, as the RPC and the app compute it).
    expect(order).toMatchObject({ price_paid: 720, original_price: 800, discount_amount: 80, user_id: aliceProfile, relationship: null });
    expect(await balance()).toBe(1280);
    const entry = await t.sql`select kind, amount_paise from wishme.ledger_entries where reference_id = ${order.id}`;
    expect(entry[0]).toMatchObject({ kind: 'booking', amount_paise: '-72000' });
    await t.sql`update public.profiles set plan = 'basic' where id = ${aliceProfile}`;
  });

  it('refuses an order the wallet cannot pay and leaves no order behind', async () => {
    await setBalance(10);
    const before = (await t.sql`select count(*)::int as n from public.wish_friend_orders`)[0]!.n;
    const res = await rest('POST', '/rest/v1/rpc/create_wish_friend_order', alice, {
      p_order_type: 'video_wish', p_celebrity_id: celebId, p_recipient_name: 'Dad', p_occasion: 'Anniversary', p_relationship: 'Father', p_tone: 'Funny',
      p_prompt: 'Make him laugh please',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/insufficient/i);
    expect((await t.sql`select count(*)::int as n from public.wish_friend_orders`)[0]!.n).toBe(before);
  });

  it('refuses reference images outside the caller\'s promotional-content folder', async () => {
    await setBalance(2000);
    const res = await rest('POST', '/rest/v1/rpc/create_wish_friend_order', alice, {
      p_order_type: 'ugc_video', p_celebrity_id: celebId, p_recipient_name: 'Mom', p_occasion: 'Birthday', p_relationship: '', p_tone: '',
      p_prompt: 'hello there friend', p_reference_image_url: `${t.env.PUBLIC_URL}/storage/v1/object/public/promotional-content/${bob.user.id}/x.jpg`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('create_ugc_ad_order keys the ad on the auth user id and leaves it pending approval', async () => {
    await setBalance(2000);
    const image = `${t.env.PUBLIC_URL}/storage/v1/object/public/promotional-content/${alice.user.id}/ugc-1-abcde.jpg`;
    const res = await rest('POST', '/rest/v1/rpc/create_ugc_ad_order', alice, {
      p_celebrity_id: null, p_product_name: 'Chai', p_product_description: 'Masala chai', p_product_image_url: image, p_prompt: 'Cosy ad',
      p_hook_style: '', p_call_to_action: 'Buy now', p_aspect_ratio: '9:16', p_details: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    const ad = res.json() as { id: string; user_id: string; status: string; price_paid: number };
    expect(ad).toMatchObject({ user_id: alice.user.id, status: 'pending_approval', price_paid: 999 });
    expect(await balance()).toBe(1001);
    const list = await rest('GET', `/rest/v1/ugc_ads?user_id=eq.${alice.user.id}&select=id,product_name,status,price_paid`, alice);
    expect(list.json()).toEqual([{ id: ad.id, product_name: 'Chai', status: 'pending_approval', price_paid: 999 }]);
    expect((await rest('GET', `/rest/v1/ugc_ads?select=id`, bob)).json()).toEqual([]);
    const noImage = await rest('POST', '/rest/v1/rpc/create_ugc_ad_order', alice, { p_celebrity_id: null, p_product_name: 'Chai', p_product_image_url: '' });
    expect(noImage.statusCode).toBe(400);
  });
});

describe('library and history rows', () => {
  it('saves a video once, only with a file key from the caller\'s own order, and deletes it', async () => {
    const order = (await t.sql<{ id: string }[]>`
      insert into public.wish_friend_orders (user_id, order_type, celebrity_id, recipient_name, occasion, prompt, status, video_file_key)
      values (${aliceProfile}, 'ugc_video', ${celebId}, 'Mom', 'Birthday', 'x', 'completed', 'videos/a.mp4') returning id`)[0]!.id;
    const save = (s: TestSession, fileKey: string) =>
      rest('POST', '/rest/v1/library_items?on_conflict=user_id,source_type,source_id', s,
        { user_id: 'ignored', kind: 'video', source_type: 'ugc_video', source_id: order, title: 'Mom', subtitle: null, media_url: null, file_key: fileKey, thumbnail_url: null },
        'return=minimal,resolution=ignore-duplicates');
    expect((await save(bob, 'videos/a.mp4')).statusCode).toBe(403);
    expect((await save(alice, 'videos/other.mp4')).statusCode).toBe(403);
    expect((await save(alice, 'videos/a.mp4')).statusCode).toBe(201);
    expect((await save(alice, 'videos/a.mp4')).statusCode).toBe(201);
    const rows = await rest('GET', `/rest/v1/library_items?user_id=eq.${aliceProfile}&kind=eq.video&select=source_id&limit=500`, alice);
    expect(rows.json()).toEqual([{ source_id: order }]);
    const id = (await t.sql`select id from public.library_items where user_id = ${aliceProfile}`)[0]!.id as string;
    expect((await rest('DELETE', `/rest/v1/library_items?id=eq.${id}`, bob)).statusCode).toBe(204);
    expect((await t.sql`select count(*)::int as n from public.library_items`)[0]!.n).toBe(1);
    expect((await rest('DELETE', `/rest/v1/library_items?id=eq.${id}`, alice)).statusCode).toBe(204);
    expect((await t.sql`select count(*)::int as n from public.library_items`)[0]!.n).toBe(0);
  });

  it('lets the owner star a greeting card and nothing else', async () => {
    const id = (await t.sql<{ id: string }[]>`
      insert into public.greeting_card_generations (user_id, original_prompt, occasion_name, recipient_name, status, generated_image_url, amount_charged)
      values (${aliceProfile}, 'p', 'Birthday', 'Mom', 'completed', 'https://cdn.test/x.png', 199) returning id`)[0]!.id;
    expect((await rest('PATCH', `/rest/v1/greeting_card_generations?id=eq.${id}`, alice, { saved_to_library: true }, 'return=minimal')).statusCode).toBe(204);
    expect((await rest('PATCH', `/rest/v1/greeting_card_generations?id=eq.${id}`, alice, { amount_charged: 0 })).statusCode).toBe(403);
    await rest('PATCH', `/rest/v1/greeting_card_generations?id=eq.${id}`, bob, { saved_to_library: false });
    const lib = await rest('GET', `/rest/v1/greeting_card_generations?user_id=eq.${aliceProfile}&saved_to_library=eq.true&status=eq.completed&select=id,generated_image_url`, alice);
    expect(lib.json()).toEqual([{ id, generated_image_url: 'https://cdn.test/x.png' }]);
  });

  it('acknowledges the app\'s invented payment id on photo wishes without storing anything', async () => {
    const id = (await t.sql<{ id: string }[]>`
      insert into public.photo_wishes (user_id, original_image_url, occasion, recipient_name, wish_message, status)
      values (${aliceProfile}, 'uploaded', 'Birthday', 'Mom', 'Hi', 'completed') returning id`)[0]!.id;
    expect((await rest('PATCH', `/rest/v1/photo_wishes?id=eq.${id}`, alice, { wishme_payment_id: 'WM-20261016-1234' })).statusCode).toBe(204);
    expect((await rest('PATCH', `/rest/v1/photo_wishes?id=eq.${id}`, alice, { edited_image_url: 'https://evil' })).statusCode).toBe(403);
  });

  it('drops the app\'s own audio history inserts (the audio functions write those rows) and keeps reads owner-only', async () => {
    const body = { user_id: bobProfile, voice_id: 'v1', voice_name: 'Aria', audio_url: 'https://cdn.test/a.mp3', status: 'completed', credits_used: 1 };
    const minimal = await rest('POST', '/rest/v1/voice_conversion_generations', alice, body, 'return=minimal');
    expect(minimal.statusCode).toBe(201);
    expect(minimal.body).toBe('');
    const rep = await rest('POST', '/rest/v1/tts_generations', alice, { text: 'hi', voice_id: 'v', audio_url: 'https://cdn.test/t.mp3' }, 'return=representation');
    expect(rep.statusCode).toBe(201);
    expect(rep.json()).toEqual([]);
    expect((await t.sql`select count(*)::int as n from public.voice_conversion_generations`)[0]!.n).toBe(0);
    await t.sql`insert into public.tts_generations (user_id, text, voice_id, audio_url, credits_used) values (${aliceProfile}, 'hello', 'v', 'https://cdn.test/t.mp3', 50)`;
    expect((await rest('GET', '/rest/v1/tts_generations?select=text,credits_used', alice)).json()).toEqual([{ text: 'hello', credits_used: 50 }]);
    expect((await rest('GET', '/rest/v1/tts_generations?select=id', bob)).json()).toEqual([]);
  });

  it('serves the Bookings tab\'s field names from the production columns', async () => {
    await t.sql`insert into public.photo_wishes (user_id, original_image_url, edited_image_url, occasion, recipient_name, wish_message, amount_charged, status)
                values (${aliceProfile}, 'uploaded', 'https://cdn.test/p.png', 'Holi', 'Ravi', 'Colours!', 99, 'completed')`;
    const photo = await rest('GET', `/rest/v1/photo_wishes?select=occasion_type,recipient_name,message,output_url,credits_used&user_id=eq.${aliceProfile}&occasion=eq.Holi`, alice);
    expect(photo.json()).toEqual([{ occasion_type: 'Holi', recipient_name: 'Ravi', message: 'Colours!', output_url: 'https://cdn.test/p.png', credits_used: 99 }]);
    await t.sql`insert into public.music_generations (user_id, song_title, song_url, generation_type, status) values (${aliceProfile}, 'Song', 'https://cdn.test/s.mp3', 'instrumental', 'completed')`;
    const music = await rest('GET', `/rest/v1/music_generations?select=title,audio_url,has_vocals&user_id=eq.${aliceProfile}`, alice);
    expect(music.json()).toEqual([{ title: 'Song', audio_url: 'https://cdn.test/s.mp3', has_vocals: false }]);
    const id = await createOrder(alice);
    const congrats = await rest('GET', `/rest/v1/wish_celebrity_orders?id=eq.${id}&select=id,status,conversation_id&limit=1`, alice);
    expect(congrats.json()).toEqual([{ id, status: 'pending', conversation_id: null }]);
  });
  it('authorises realtime only for the caller\'s own rows or their celebrity\'s', async () => {
    const rule = t.deps.policies.table('image_promotions')!.realtime!;
    const identity = { profileId: aliceProfile, celebrityIds: [celebId], profileRole: 'user' };
    const auth = await t.deps.resolver.resolve(alice.access_token);
    expect(await rule.authorize(auth, identity, 'user_id', aliceProfile, t.deps)).toBe(true);
    expect(await rule.authorize(auth, identity, 'user_id', bobProfile, t.deps)).toBe(false);
    expect(await rule.authorize(auth, identity, 'celebrity_id', celebId, t.deps)).toBe(true);
    expect(await rule.authorize(auth, identity, 'celebrity_id', otherCelebId, t.deps)).toBe(false);
  });
});
