/**
 * The ledger and Razorpay payments: self-correcting balances with and without the Supabase-style trigger,
 * idempotency, insufficient funds, server-side pricing, signature checks, webhook/callback races and reconciliation
 * of the app's follow-up "mirror" rows. Razorpay's API is stubbed; nothing leaves the machine.
 */
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { claimMirror, markMirrorable } from '../../src/domains/wallet/mirrors.js';
import { bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

const KEY_ID = 'rzp_test_key';
const KEY_SECRET = 'rzp_test_secret_0123456789';
const WEBHOOK_SECRET = 'rzp_webhook_secret_0123456789';

interface FakePayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
}

const realFetch = globalThis.fetch;
const payments = new Map<string, FakePayment>();
let orderSeq = 0;

function stubRazorpay() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.razorpay.com/')) return realFetch(input, init);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/v1/orders') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { amount: number; currency: string; receipt: string; notes: Record<string, string> };
      return json(200, { id: `order_${++orderSeq}`, entity: 'order', amount: body.amount, amount_paid: 0, currency: body.currency, receipt: body.receipt, status: 'created', notes: body.notes, created_at: 0 });
    }
    const pay = /\/v1\/payments\/([^/]+)$/.exec(url);
    if (pay) {
      const p = payments.get(decodeURIComponent(pay[1]!));
      return p ? json(200, p) : json(404, { error: { description: 'not found' } });
    }
    return json(404, {});
  });
}

const sign = (orderId: string, paymentId: string) => createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

let t: TestCtx;
let user: TestSession;
let profileId: string;

beforeAll(async () => {
  t = await bootTest({
    extraFixtures: ['balance-trigger.sql'],
    env: { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET },
  });
  user = await signUp(t, 'payer@example.com');
  profileId = await profileIdOf(t, user.user.id);
  await t.sql`insert into public.plans (name, price, service_discount_percentage) values ('premium', 999, 10), ('elite', 1999, 20)`;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => t.close());

const balance = async () => Number((await t.sql`select wallet_balance from public.profiles where id = ${profileId}`)[0]!.wallet_balance);
const resetBalance = async (rupees: number) => t.sql`update public.profiles set wallet_balance = ${rupees} where id = ${profileId}`;

describe('ledger', () => {
  it('lands on the intended balance whether or not a trigger also applied the row', async () => {
    await resetBalance(100);
    // The fixture trigger applies the history row itself: the ledger must not double it.
    const r = await t.deps.ledger.run('user_wallet', { accountId: profileId, deltaPaise: 5000, kind: 'deposit', idempotencyKey: 'test:dep:1', createdBy: 'test' });
    expect(await balance()).toBe(150);
    expect(r.balanceAfterPaise).toBe(15000);
    // A record-only movement (deltaPaise 0) of a debit type: the trigger subtracts, the ledger restores.
    await t.deps.ledger.run('user_wallet', { accountId: profileId, deltaPaise: 0, displayPaise: 99900, kind: 'plan_purchase', idempotencyKey: 'test:plan:1', createdBy: 'test', paymentMethod: 'razorpay' });
    expect(await balance()).toBe(150);
  });

  it('is idempotent per key', async () => {
    await resetBalance(100);
    const a = await t.deps.ledger.run('user_wallet', { accountId: profileId, deltaPaise: -2000, kind: 'service_payment', idempotencyKey: 'test:pay:1', createdBy: 'test' });
    const b = await t.deps.ledger.run('user_wallet', { accountId: profileId, deltaPaise: -2000, kind: 'service_payment', idempotencyKey: 'test:pay:1', createdBy: 'test' });
    expect(b.alreadyApplied).toBe(true);
    expect(b.ledgerId).toBe(a.ledgerId);
    expect(await balance()).toBe(80);
  });

  it('refuses a debit beyond the balance and changes nothing', async () => {
    await resetBalance(10);
    await expect(
      t.deps.ledger.run('user_wallet', { accountId: profileId, deltaPaise: -2000, kind: 'service_payment', idempotencyKey: 'test:pay:2', createdBy: 'test' }),
    ).rejects.toMatchObject({ status: 400, code: 'insufficient_balance' });
    expect(await balance()).toBe(10);
  });

  it('serialises concurrent debits so the balance never goes negative', async () => {
    await resetBalance(50);
    const attempts = Array.from({ length: 8 }, (_, i) =>
      t.deps.ledger.run('user_wallet', { accountId: profileId, deltaPaise: -1000, kind: 'service_payment', idempotencyKey: `test:race:${i}`, createdBy: 'test' }).then(
        () => 'ok',
        () => 'refused',
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect(await balance()).toBe(0);
  });

  it('lets a later client mirror row claim a server movement exactly once', async () => {
    await resetBalance(100);
    await t.deps.ledger.run('user_wallet', {
      accountId: profileId,
      deltaPaise: -3000,
      kind: 'withdrawal',
      idempotencyKey: 'test:booking:1',
      createdBy: 'test',
      details: markMirrorable({ service_type: 'booking', order_id: 'b-1' }),
      reference: { type: 'booking', id: 'b-1' },
    });
    const first = await claimMirror(t.deps.db, { accountId: profileId, absAmountPaise: 3000, kinds: ['withdrawal'], table: 'wallet_transactions' });
    expect(first?.referenceId).toBe('b-1');
    const again = await claimMirror(t.deps.db, { accountId: profileId, absAmountPaise: 3000, kinds: ['withdrawal'], table: 'wallet_transactions' });
    expect(again).toBeNull();
    const otherTable = await claimMirror(t.deps.db, { accountId: profileId, absAmountPaise: 3000, kinds: ['withdrawal'], table: 'payment_transactions', referenceId: 'b-1' });
    expect(otherTable).not.toBeNull();
  });
});

describe('ledger invariant', () => {
  it('flags a balance changed behind the ledger, but not one moved by a legacy trigger with its own history row', async () => {
    const other = await signUp(t, 'invariant@example.com');
    const acct = await profileIdOf(t, other.user.id);
    await t.deps.ledger.run('user_wallet', { accountId: acct, deltaPaise: 10_000, kind: 'deposit', idempotencyKey: 'test:inv:dep', createdBy: 'test' });
    const mine = async () => (await t.deps.ledger.verifyInvariants(100_000)).filter((m) => m.accountId === acct);
    expect(await mine()).toEqual([]);

    // A silent change to the column (no history row): a real fault.
    await t.sql`update public.profiles set wallet_balance = wallet_balance + 7 where id = ${acct}`;
    expect(await mine()).toEqual([{ kind: 'user_wallet', accountId: acct, ledgerPaise: 10_000, columnPaise: 10_700 }]);

    // A production trigger path (referral commission): history row plus balance change, outside the ledger.
    await t.sql`update public.profiles set wallet_balance = 100 where id = ${acct}`;
    await t.sql`insert into public.wallet_transactions (user_id, transaction_type, amount, status, payment_method) values (${acct}, 'referral_commission', 5, 'completed', 'wallet')`;
    expect(await mine()).toEqual([]);
  });
});

describe('Razorpay deposits and plans', () => {
  it('prices plan orders on the server, ignoring the client amount', async () => {
    stubRazorpay();
    const res = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/create-razorpay-order',
      headers: bearer(user.access_token),
      payload: { amount: 1, currency: 'INR', receipt: 'plan_x', notes: { type: 'plan_purchase', plan_name: 'Premium' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ amount: 99900, currency: 'INR', key_id: KEY_ID });
  });

  it('enforces deposit limits', async () => {
    stubRazorpay();
    const res = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/create-razorpay-order',
      headers: bearer(user.access_token),
      payload: { amount: 50, currency: 'INR', notes: { type: 'wallet_deposit' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/minimum/i);
  });

  it('credits a verified deposit once, even when the webhook and the callback both arrive', async () => {
    stubRazorpay();
    await resetBalance(0);
    const order = (
      await t.app.inject({ method: 'POST', url: '/functions/v1/create-razorpay-order', headers: bearer(user.access_token), payload: { amount: 500, notes: { type: 'wallet_deposit' } } })
    ).json() as { id: string; amount: number };
    payments.set('pay_1', { id: 'pay_1', order_id: order.id, amount: order.amount, currency: 'INR', status: 'captured' });

    const forged = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/verify-razorpay-payment',
      headers: bearer(user.access_token),
      payload: { razorpay_order_id: order.id, razorpay_payment_id: 'pay_1', razorpay_signature: 'deadbeef' },
    });
    expect(forged.statusCode).toBe(400);

    const webhookBody = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: payments.get('pay_1') } } });
    const hook = await t.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(webhookBody).digest('hex'), 'x-razorpay-event-id': 'evt_1' },
      payload: webhookBody,
    });
    expect(hook.statusCode).toBe(200);
    expect(await balance()).toBe(500);

    const verify = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/verify-razorpay-payment',
      headers: bearer(user.access_token),
      payload: { razorpay_order_id: order.id, razorpay_payment_id: 'pay_1', razorpay_signature: sign(order.id, 'pay_1') },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ success: true });
    expect(verify.json().wishme_payment_id).toMatch(/^WM\d{14}$/);
    expect(await balance()).toBe(500);

    const dup = await t.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(webhookBody).digest('hex'), 'x-razorpay-event-id': 'evt_1' },
      payload: webhookBody,
    });
    expect(dup.json().status).toBe('duplicate');
    const records = await t.sql`select count(*)::int as n from public.payment_transactions where razorpay_payment_id = 'pay_1'`;
    expect(records[0]!.n).toBe(1);
  });

  it('refuses a payment whose amount differs from the order, and another user verifying it', async () => {
    stubRazorpay();
    const order = (
      await t.app.inject({ method: 'POST', url: '/functions/v1/create-razorpay-order', headers: bearer(user.access_token), payload: { amount: 300, notes: { type: 'wallet_deposit' } } })
    ).json() as { id: string };
    payments.set('pay_short', { id: 'pay_short', order_id: order.id, amount: 100, currency: 'INR', status: 'captured' });
    const short = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/verify-razorpay-payment',
      headers: bearer(user.access_token),
      payload: { razorpay_order_id: order.id, razorpay_payment_id: 'pay_short', razorpay_signature: sign(order.id, 'pay_short') },
    });
    expect(short.statusCode).toBe(400);
    const mallory = await signUp(t, 'mallory@example.com');
    const theft = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/verify-razorpay-payment',
      headers: bearer(mallory.access_token),
      payload: { razorpay_order_id: order.id, razorpay_payment_id: 'pay_short', razorpay_signature: sign(order.id, 'pay_short') },
    });
    expect(theft.statusCode).toBe(403);
  });

  it('sets the plan on fulfilment without touching the wallet', async () => {
    stubRazorpay();
    await resetBalance(40);
    const order = (
      await t.app.inject({
        method: 'POST',
        url: '/functions/v1/create-razorpay-order',
        headers: bearer(user.access_token),
        payload: { amount: 1999, notes: { type: 'plan_purchase', plan_name: 'elite' } },
      })
    ).json() as { id: string; amount: number };
    payments.set('pay_plan', { id: 'pay_plan', order_id: order.id, amount: order.amount, currency: 'INR', status: 'captured' });
    const verify = await t.app.inject({
      method: 'POST',
      url: '/functions/v1/verify-razorpay-payment',
      headers: bearer(user.access_token),
      payload: { razorpay_order_id: order.id, razorpay_payment_id: 'pay_plan', razorpay_signature: sign(order.id, 'pay_plan') },
    });
    expect(verify.statusCode).toBe(200);
    const plan = await t.sql`select plan from public.profiles where id = ${profileId}`;
    expect(plan[0]!.plan).toBe('elite');
    expect(await balance()).toBe(40);
  });
});

describe('Scan & Pay (/api/v1/wallet/pay)', () => {
  it('debits atomically and de-duplicates by idempotency key', async () => {
    await resetBalance(100);
    const pay = (key: string) =>
      t.app.inject({ method: 'POST', url: '/api/v1/wallet/pay', headers: bearer(user.access_token), payload: { payee_id: 'shop@upi', payee_name: 'Shop', amount: 25, idempotency_key: key } });
    const a = await pay('scan-key-0001');
    expect(a.statusCode).toBe(200);
    expect(a.json().wallet_balance).toBe(75);
    const b = await pay('scan-key-0001');
    expect(b.json().duplicate).toBe(true);
    expect(await balance()).toBe(75);
  });
});
