/**
 * Accounts money tables through /rest/v1: client-written wallet_transactions, payment_transactions, payout_requests and
 * the plan PATCH. Credits are only accepted as mirrors of server movements, debits are executed by the ledger with a
 * balance check, payouts hold the celebrity balance atomically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markMirrorable } from '../../src/domains/wallet/mirrors.js';
import { bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;
let aliceProfile: string;
let bobProfile: string;
let bobCeleb: string;

const balanceOf = async (profileId: string) =>
  Number((await t.sql<{ b: string }[]>`select wallet_balance::text as b from public.profiles where id = ${profileId}`)[0]!.b);
const celebBalance = async (id: string) =>
  Number((await t.sql<{ b: string }[]>`select available_balance::text as b from public.celebrities where id = ${id}`)[0]!.b);

const post = (token: string, table: string, payload: unknown, prefer?: string) =>
  t.app.inject({ method: 'POST', url: `/rest/v1/${table}`, headers: { ...bearer(token), ...(prefer ? { prefer } : {}) }, payload: payload as object });

/** Simulates a fulfilled Razorpay order the way Payments.fulfil leaves it. */
async function fulfilledOrder(profileId: string, userId: string, purpose: 'wallet_deposit' | 'plan_purchase', paise: number, paymentId: string, notes: Record<string, unknown> = {}) {
  const r = await t.deps.ledger.run('user_wallet', {
    accountId: profileId,
    deltaPaise: purpose === 'wallet_deposit' ? paise : 0,
    ...(purpose === 'plan_purchase' ? { displayPaise: paise } : {}),
    kind: purpose === 'wallet_deposit' ? 'deposit' : 'plan_purchase',
    idempotencyKey: `rzp:${paymentId}`,
    createdBy: 'system:razorpay',
    paymentMethod: 'razorpay',
    reference: { type: 'razorpay_payment', id: paymentId },
  });
  await t.sql`
    insert into wishme.payment_orders (razorpay_order_id, user_id, profile_id, purpose, amount_paise, notes, status,
      razorpay_payment_id, wishme_payment_id, fulfilment, fulfilled_at)
    values (${`order_${paymentId}`}, ${userId}, ${profileId}, ${purpose}, ${paise}, ${t.sql.json(notes as never)}, 'fulfilled',
      ${paymentId}, ${`WM${paymentId}`}, ${t.sql.json({ wallet_transaction_id: r.historyRowId } as never)}, now())`;
  await t.sql`
    insert into public.payment_transactions (wishme_payment_id, user_id, amount, payment_method, service_type, razorpay_payment_id, status)
    values (${`WM${paymentId}`}, ${profileId}, ${paise / 100}, 'razorpay', 'deposit', ${paymentId}, 'completed')`;
  return r.historyRowId!;
}

beforeAll(async () => {
  // The production update_wallet_balance trigger, so the ledger's self-correction is exercised against it.
  t = await bootTest({ extraFixtures: ['balance-trigger.sql'] });
  alice = await signUp(t, 'alice.money@example.com', undefined, { first_name: 'Alice', phone: '9000000101' });
  bob = await signUp(t, 'bob.money@example.com', undefined, { first_name: 'Bob', phone: '9000000102' });
  aliceProfile = await profileIdOf(t, alice.user.id);
  bobProfile = await profileIdOf(t, bob.user.id);
  const c = await t.sql<{ id: string }[]>`
    insert into public.celebrities (profile_id, name, category, available_balance) values (${bobProfile}, 'Bob Star', 'Singer', 1000) returning id`;
  bobCeleb = c[0]!.id;
  await t.deps.resolver.forgetIdentity(bob.user.id);
});
afterAll(async () => {
  await t.close();
});

describe('wallet_transactions credits', () => {
  it('refuses a forged deposit', async () => {
    const res = await post(alice.access_token, 'wallet_transactions', { user_id: aliceProfile, transaction_type: 'deposit', amount: 5000, status: 'completed' });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('Credits are recorded by the server');
    expect(await balanceOf(aliceProfile)).toBe(0);
  });

  it('answers the DepositModal mirror with the server row and credits only once', async () => {
    const rowId = await fulfilledOrder(aliceProfile, alice.user.id, 'wallet_deposit', 50_000, 'pay_dep1');
    expect(await balanceOf(aliceProfile)).toBe(500);
    const res = await post(
      alice.access_token,
      'wallet_transactions',
      { user_id: aliceProfile, transaction_type: 'deposit', amount: 500, status: 'completed', payment_method: 'razorpay', transaction_details: { razorpay_order_id: 'order_pay_dep1', razorpay_payment_id: 'pay_dep1' } },
      'return=representation',
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()[0].id).toBe(rowId);
    expect(await balanceOf(aliceProfile)).toBe(500);
    const rows = await t.sql`select id from public.wallet_transactions where user_id = ${aliceProfile} and transaction_type = 'deposit'`;
    expect(rows).toHaveLength(1);
  });

  it("refuses a mirror that names someone else's payment or another amount", async () => {
    const other = await post(bob.access_token, 'wallet_transactions', { transaction_type: 'deposit', amount: 500, transaction_details: { razorpay_payment_id: 'pay_dep1' } });
    expect(other.statusCode).toBe(403);
    const amount = await post(alice.access_token, 'wallet_transactions', { transaction_type: 'deposit', amount: 5000, transaction_details: { razorpay_payment_id: 'pay_dep1' } });
    expect(amount.statusCode).toBe(403);
  });
});

describe('wallet_transactions debits', () => {
  it('executes Scan & Pay as a ledger debit and returns the row', async () => {
    const res = await post(
      alice.access_token,
      'wallet_transactions',
      {
        user_id: bobProfile, // ignored: the owner comes from the token
        amount: 120,
        transaction_type: 'service_payment',
        status: 'pending',
        payment_method: 'wallet',
        description: 'Scan & Pay · Tea Stall',
        transaction_details: { channel: 'scan_pay', payee_id: 'tea@upi', mirrorable: true },
      },
      'return=representation',
    );
    expect(res.statusCode).toBe(201);
    const row = res.json()[0];
    expect(row.id).toBeTruthy();
    expect(row.user_id).toBe(aliceProfile);
    expect(row.status).toBe('completed');
    expect(row.transaction_details.mirrorable).toBeUndefined();
    expect(await balanceOf(aliceProfile)).toBe(380);
  });

  it('treats an identical insert seconds later as the same payment', async () => {
    const body = { amount: 10, transaction_type: 'service_payment', description: 'Scan & Pay · Same', transaction_details: { channel: 'scan_pay' } };
    const a = await post(alice.access_token, 'wallet_transactions', body, 'return=representation');
    const b = await post(alice.access_token, 'wallet_transactions', body, 'return=representation');
    expect(a.json()[0].id).toBe(b.json()[0].id);
    expect(await balanceOf(aliceProfile)).toBe(370);
  });

  it('answers 400 "Insufficient wallet balance" without moving money', async () => {
    const res = await post(alice.access_token, 'wallet_transactions', { amount: 100000, transaction_type: 'service_payment', description: 'too much' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Insufficient wallet balance');
    expect(await balanceOf(aliceProfile)).toBe(370);
  });

  it('debits negative-amount wish rows and keeps the reference', async () => {
    const orderId = '11111111-1111-4111-8111-111111111111';
    const res = await post(alice.access_token, 'wallet_transactions', {
      user_id: aliceProfile, amount: -70, type: 'debit', transaction_type: 'greeting_card_generation', reference_id: orderId, status: 'completed', description: 'Wish order',
    });
    expect(res.statusCode).toBe(201);
    expect(await balanceOf(aliceProfile)).toBe(300);
    const led = await t.sql`select amount_paise::int as p, reference_type, reference_id from wishme.ledger_entries where reference_id = ${orderId}`;
    expect(led[0]).toMatchObject({ p: -7000, reference_type: 'client', reference_id: orderId });
  });

  it('claims a server charge instead of debiting twice', async () => {
    const bookingId = '22222222-2222-4222-8222-222222222222';
    await t.deps.ledger.run('user_wallet', {
      accountId: aliceProfile, deltaPaise: -5000, kind: 'withdrawal', idempotencyKey: `booking:${bookingId}:debit`, createdBy: 'system:test',
      details: markMirrorable({ service_type: 'booking', order_id: bookingId }), reference: { type: 'booking', id: bookingId },
    });
    expect(await balanceOf(aliceProfile)).toBe(250);
    const res = await post(alice.access_token, 'wallet_transactions', { user_id: aliceProfile, transaction_type: 'withdrawal', amount: 50, status: 'completed', payment_method: 'wallet' });
    expect(res.statusCode).toBe(201);
    expect(await balanceOf(aliceProfile)).toBe(250);

    const pay = await post(alice.access_token, 'payment_transactions', {
      wishme_payment_id: 'WM-client-invented', user_id: aliceProfile, amount: 50, payment_method: 'wallet', service_type: 'booking', booking_id: bookingId, status: 'completed',
    }, 'return=representation');
    expect(pay.statusCode).toBe(201);
    expect(pay.json()[0].wishme_payment_id).toMatch(/^WM\d{14}$/);
    expect(pay.json()[0].booking_id).toBe(bookingId);
    const again = await post(alice.access_token, 'payment_transactions', { amount: 50, service_type: 'booking', booking_id: bookingId });
    expect(again.statusCode).toBe(403);
  });

  it('refuses unknown transaction types and plan rows without a payment', async () => {
    expect((await post(alice.access_token, 'wallet_transactions', { amount: 5, transaction_type: 'mystery' })).statusCode).toBe(400);
    expect((await post(alice.access_token, 'wallet_transactions', { amount: 5, transaction_type: 'plan_purchase' })).statusCode).toBe(403);
    // Production stores whole rupees.
    const fraction = await post(alice.access_token, 'wallet_transactions', { amount: 10.5, transaction_type: 'service_payment' });
    expect(fraction.statusCode).toBe(400);
    expect(fraction.json().message).toBe('Amounts must be in whole rupees');
  });
});

describe('payment_transactions', () => {
  it('answers the deposit record with the row verify already wrote', async () => {
    const res = await post(alice.access_token, 'payment_transactions', {
      wishme_payment_id: 'WMclient', user_id: aliceProfile, amount: 500, payment_method: 'razorpay', service_type: 'deposit', razorpay_payment_id: 'pay_dep1', razorpay_order_id: 'order_pay_dep1', status: 'completed',
    });
    expect(res.statusCode).toBe(201);
    const rows = await t.sql`select wishme_payment_id from public.payment_transactions where razorpay_payment_id = 'pay_dep1'`;
    expect(rows).toEqual([{ wishme_payment_id: 'WMpay_dep1' }]);
  });

  it('refuses a payment record nothing on the server matches', async () => {
    const res = await post(alice.access_token, 'payment_transactions', { amount: 99, service_type: 'photo_wish', photo_wish_id: '33333333-3333-4333-8333-333333333333' });
    expect(res.statusCode).toBe(403);
  });

  it('reads only the caller\'s rows', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/rest/v1/payment_transactions?user_id=eq.${aliceProfile}&select=wishme_payment_id,amount`, headers: bearer(bob.access_token) });
    expect(res.json()).toEqual([]);
  });
});

describe('profiles.plan PATCH after Razorpay', () => {
  it('is refused without a fulfilled plan order and confirmed (without a write) with one', async () => {
    const url = `/rest/v1/profiles?id=eq.${bobProfile}`;
    const no = await t.app.inject({ method: 'PATCH', url, headers: { ...bearer(bob.access_token), prefer: 'return=minimal' }, payload: { plan: 'elite' } });
    expect(no.statusCode).toBe(403);
    await t.sql`update public.profiles set plan = 'premium' where id = ${bobProfile}`;
    await fulfilledOrder(bobProfile, bob.user.id, 'plan_purchase', 99_900, 'pay_plan1', { plan_name: 'Premium' });
    const ok = await t.app.inject({ method: 'PATCH', url, headers: { ...bearer(bob.access_token), prefer: 'return=minimal' }, payload: { plan: 'premium' } });
    expect(ok.statusCode).toBe(204);
    const mixed = await t.app.inject({ method: 'PATCH', url, headers: bearer(bob.access_token), payload: { plan: 'premium', first_name: 'B' } });
    expect(mixed.statusCode).toBe(403);
  });

  it('accepts the select-plan wallet_transactions mirror for the paid plan', async () => {
    const res = await post(bob.access_token, 'wallet_transactions', {
      user_id: bobProfile, transaction_type: 'plan_purchase', amount: 999, status: 'completed', payment_method: 'razorpay',
      transaction_details: { plan_name: 'Premium', razorpay_payment_id: 'pay_plan1', razorpay_order_id: 'order_pay_plan1' },
    });
    expect(res.statusCode).toBe(201);
    expect(await balanceOf(bobProfile)).toBe(0);
  });
});

describe('bank_details and payout_requests', () => {
  it('validates and owns bank details', async () => {
    const bad = await post(bob.access_token, 'bank_details', { bank_name: 'HDFC', bank_account_number: '12345678901', ifsc_code: 'HDFC123', account_holder_name: 'Bob', user_id: aliceProfile });
    expect(bad.statusCode).toBe(400);
    const ok = await post(bob.access_token, 'bank_details', { bank_name: 'HDFC Bank', bank_account_number: '1234 5678 901', ifsc_code: 'hdfc0001234', account_holder_name: 'Bob Star', user_id: aliceProfile });
    expect(ok.statusCode).toBe(201);
    const row = await t.sql`select user_id, ifsc_code, account_number from public.bank_details`;
    expect(row).toEqual([{ user_id: bobProfile, ifsc_code: 'HDFC0001234', account_number: '12345678901' }]);
    // WalletTab reads bank_account_number: star reads carry it as an alias of account_number.
    const mine = await t.app.inject({ method: 'GET', url: `/rest/v1/bank_details?user_id=eq.${bobProfile}&order=created_at.desc`, headers: bearer(bob.access_token) });
    expect(mine.json()[0]).toMatchObject({ account_number: '12345678901', bank_account_number: '12345678901' });
    const peek = await t.app.inject({ method: 'GET', url: `/rest/v1/bank_details?user_id=eq.${bobProfile}`, headers: bearer(alice.access_token) });
    expect(peek.json()).toEqual([]);
  });

  it('holds the balance and snapshots the saved bank account', async () => {
    const res = await post(bob.access_token, 'payout_requests', {
      celebrity_id: bobCeleb, profile_id: aliceProfile, requested_amount: 300, bank_name: 'Evil Bank', bank_account_number: '12345678901', ifsc_code: 'EVIL0000001', account_holder_name: 'Mallory', status: 'approved',
    });
    expect(res.statusCode).toBe(201);
    expect(await celebBalance(bobCeleb)).toBe(700);
    const rows = await t.sql`select profile_id, requested_amount::text as amt, bank_name, ifsc_code, account_holder_name, status from public.payout_requests`;
    expect(rows).toEqual([{ profile_id: bobProfile, amt: '300', bank_name: 'HDFC Bank', ifsc_code: 'HDFC0001234', account_holder_name: 'Bob Star', status: 'pending' }]);
    const led = await t.sql`select amount_paise::int as p, kind from wishme.ledger_entries where account_kind = 'celebrity_earnings'`;
    expect(led).toEqual([{ p: -30000, kind: 'payout_hold' }]);
  });

  it('works without an account number (WithdrawModal) by using the default account', async () => {
    const res = await post(bob.access_token, 'payout_requests', { celebrity_id: bobCeleb, profile_id: bobProfile, requested_amount: 50, status: 'pending' });
    expect(res.statusCode).toBe(201);
    expect(await celebBalance(bobCeleb)).toBe(650);
  });

  it('refuses more than the balance, other celebrities and unknown bank accounts', async () => {
    const big = await post(bob.access_token, 'payout_requests', { celebrity_id: bobCeleb, requested_amount: 5000, bank_account_number: '12345678901' });
    expect(big.statusCode).toBe(400);
    expect(await celebBalance(bobCeleb)).toBe(650);
    const other = await post(alice.access_token, 'payout_requests', { celebrity_id: bobCeleb, requested_amount: 10 });
    expect(other.statusCode).toBe(403);
    const unknownBank = await post(bob.access_token, 'payout_requests', { celebrity_id: bobCeleb, requested_amount: 10, bank_account_number: '99999999' });
    expect(unknownBank.statusCode).toBe(400);
  });

  it("lists payouts only for the caller's celebrities", async () => {
    const mine = await t.app.inject({ method: 'GET', url: `/rest/v1/payout_requests?celebrity_id=eq.${bobCeleb}&order=requested_at.desc&limit=20`, headers: bearer(bob.access_token) });
    expect(mine.json()).toHaveLength(2);
    const theirs = await t.app.inject({ method: 'GET', url: `/rest/v1/payout_requests?celebrity_id=eq.${bobCeleb}`, headers: bearer(alice.access_token) });
    expect(theirs.json()).toEqual([]);
  });

  it('celebrity-payout function holds the balance for the caller and refuses non-celebrities', async () => {
    const payout = (token: string, payload: object) =>
      t.app.inject({ method: 'POST', url: '/functions/v1/celebrity-payout', headers: bearer(token), payload });
    const res = await payout(bob.access_token, {
      amount: 100, bank_name: 'Evil Bank', account_number: '12345678901', ifsc_code: 'EVIL0000001', account_holder_name: 'Mallory',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, status: 'pending', available_balance: 550 });
    expect(await celebBalance(bobCeleb)).toBe(550);
    const [row] = await t.sql`select bank_name, requested_amount::text as amt, status from public.payout_requests where id = ${res.json().payout_id}`;
    expect(row).toEqual({ bank_name: 'HDFC Bank', amt: '100', status: 'pending' });

    const big = await payout(bob.access_token, { amount: 5000 });
    expect(big.statusCode).toBe(400);
    expect(await celebBalance(bobCeleb)).toBe(550);
    const notCeleb = await payout(alice.access_token, { amount: 10 });
    expect(notCeleb.statusCode).toBe(403);
  });
});
