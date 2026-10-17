/**
 * Client-written money rows, intercepted (ADR 0004, CONTRIBUTING.md rule 3):
 *
 *  wallet_transactions   credits and Razorpay-paid plan rows are only accepted as mirrors of what the server already did;
 *                        debits are claimed as mirrors of a server charge, or else executed by the ledger with a balance
 *                        check. The client's amount sign, status and balance effect are never trusted.
 *  payment_transactions  mirrors only; the row is written by the server with the server's amount and payment id.
 *  payout_requests       the celebrity's balance is held by the ledger and the request row written in one transaction,
 *                        with the bank snapshot taken from the caller's own bank_details.
 *
 * Mirror convention shared with the other domains (coordinator note): a server charge the app follows up with its own
 * rows is recorded with kind = the app's transaction_type for that flow, details = markMirrorable({ service_type,
 * order_id }) and reference = { type: <domain>, id: <domain row id> }.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompatResult, CustomArgs } from '../../compat/postgrest/policy.js';
import { randomDigits, uuid } from '../../lib/crypto.js';
import { AppError, badRequest, forbidden } from '../../lib/errors.js';
import { fromRupees, positiveAmount, rupeesForColumn } from '../../lib/money.js';
import { resolveWishOrderDebit, wishOrderIdFromDescription } from '../content/wish-orders.js';
import { claimMirror, markMirrorable, MIRROR_WINDOW_SEC } from '../wallet/mirrors.js';
import { CREDIT_TYPES, DEBIT_TYPES, InsufficientFunds } from '../wallet/ledger.js';
import { cleanText, insertRow, represent } from './rows.js';

/** Rupee value for a money column (integer rupees in production: whole rupees only). */
const amountFor = (a: CustomArgs, table: string, column: string, paise: number) =>
  rupeesForColumn(paise, a.deps.schema.table(table)?.columns.get(column)?.type);

/** Largest single client-initiated wallet debit (₹1,00,000, the deposit ceiling). */
const MAX_DEBIT_PAISE = 100_000 * 100;
/** Largest single payout request (₹10,00,000). */
const MAX_PAYOUT_RUPEES = 1_000_000;
/** Window in which an identical client debit is treated as the same request (double tap, network retry). */
const DEBIT_DEDUPE_SEC = 15;
const PLAN_TYPES = new Set(['plan_purchase', 'plan_upgrade']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CREDITS_REFUSED = 'Credits are recorded by the server';

const amountField = z.union([z.number().finite(), z.string().trim().min(1).max(20)]);
const optText = (max: number) => z.string().max(max).nullish();
const optUuid = z.string().regex(UUID).nullish();

function oneRow(body: unknown): unknown {
  if (Array.isArray(body)) {
    if (body.length !== 1) throw badRequest('Insert exactly one row', 'PGRST102');
    return body[0];
  }
  return body;
}

function parseRow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const r = schema.safeParse(oneRow(body));
  if (!r.success) {
    const i = r.error.issues[0];
    throw new AppError(400, 'PGRST102', `Invalid ${i?.path.join('.') || 'row'}: ${i?.message ?? 'invalid value'}`);
  }
  return r.data;
}

function caller(a: CustomArgs): { userId: string; profileId: string } {
  if (a.auth.kind === 'anon' || !a.auth.userId) throw new AppError(401, '42501', 'permission denied: sign in required');
  if (!a.identity.profileId) throw forbidden('A profile is required', '42501');
  return { userId: a.auth.userId, profileId: a.identity.profileId };
}

/** Keeps a small, flat copy of client-supplied details; drops keys that carry meaning for the ledger. */
function safeDetails(input: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (Object.keys(out).length >= 12) break;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k)) continue;
    if (/^(mirrorable|claimed_|display_paise|order_id|service_type|razorpay_)/.test(k)) continue;
    if (typeof v === 'string') out[k] = cleanText(v, 500);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

export function newWishmePaymentId(): string {
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `WM${ymd}${randomDigits(8)}`;
}

// ── wallet_transactions ──────────────────────────────────────────────────────────────────────────────────────

const WalletRow = z.object({
  transaction_type: z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/, 'unknown transaction type'),
  amount: amountField,
  status: optText(20),
  payment_method: optText(20),
  description: optText(1000),
  transaction_details: z.record(z.unknown()).nullish(),
  reference_id: optText(100),
  booking_id: optUuid,
});
type WalletRow = z.infer<typeof WalletRow>;

export async function insertWalletTransaction(a: CustomArgs): Promise<CompatResult> {
  const me = caller(a);
  const row = parseRow(WalletRow, a.body);
  const signed = fromRupees(row.amount);
  const abs = Math.abs(signed);
  if (abs === 0) throw badRequest('Amount must not be zero', 'invalid_amount');
  const type = row.transaction_type;
  const details = row.transaction_details ?? {};
  const rzpPaymentId = typeof details.razorpay_payment_id === 'string' ? details.razorpay_payment_id : null;

  if (CREDIT_TYPES.has(type) || (PLAN_TYPES.has(type) && rzpPaymentId)) {
    return mirrorWalletCredit(a, me, row, abs, rzpPaymentId);
  }
  if (PLAN_TYPES.has(type)) {
    // A plan is bought through Razorpay checkout; a plan row without a payment is only accepted as a mirror.
    const claimed = await claimMirror(a.deps.db, { accountId: me.profileId, absAmountPaise: abs, kinds: [type], table: 'wallet_transactions', referenceId: row.reference_id ?? null });
    if (!claimed) throw forbidden('Plans are purchased through checkout', '42501');
    return represent(a, 'wallet_transactions', claimed.historyRowId ? [claimed.historyRowId] : []);
  }
  if (DEBIT_TYPES.has(type) || signed < 0) return walletDebit(a, me, row, abs);
  throw badRequest(`Unsupported transaction type: ${type}`, 'unsupported_transaction_type');
}

async function mirrorWalletCredit(a: CustomArgs, me: { userId: string; profileId: string }, row: WalletRow, abs: number, rzpPaymentId: string | null): Promise<CompatResult> {
  if (rzpPaymentId) {
    const order = await a.deps.payments.fulfilledByPayment(rzpPaymentId, me.userId);
    const purposeOk = order && (PLAN_TYPES.has(row.transaction_type) ? order.purpose === 'plan_purchase' : row.transaction_type === 'deposit' && order.purpose === 'wallet_deposit');
    if (!order || !purposeOk || order.profile_id !== me.profileId || Number(order.amount_paise) !== abs) {
      throw forbidden(CREDITS_REFUSED, '42501');
    }
    const rowId = typeof order.fulfilment?.wallet_transaction_id === 'string' ? order.fulfilment.wallet_transaction_id : null;
    return represent(a, 'wallet_transactions', rowId ? [rowId] : []);
  }
  const claimed = await claimMirror(a.deps.db, {
    accountId: me.profileId,
    absAmountPaise: abs,
    kinds: [row.transaction_type],
    table: 'wallet_transactions',
    referenceId: row.reference_id ?? null,
  });
  if (!claimed) throw forbidden(CREDITS_REFUSED, '42501');
  return represent(a, 'wallet_transactions', claimed.historyRowId ? [claimed.historyRowId] : []);
}

async function walletDebit(a: CustomArgs, me: { userId: string; profileId: string }, row: WalletRow, abs: number): Promise<CompatResult> {
  const { deps } = a;
  const type = row.transaction_type;
  // Another domain may already have charged for this flow (the app writes its own follow-up row).
  const claimed = await claimMirror(deps.db, { accountId: me.profileId, absAmountPaise: abs, kinds: [type], table: 'wallet_transactions', referenceId: row.reference_id ?? null });
  if (claimed) return represent(a, 'wallet_transactions', claimed.historyRowId ? [claimed.historyRowId] : []);

  // Wallet-paid wish orders: the app debits with "Wish order #<id>" (and sometimes reference_id). The order's server
  // price replaces the client amount, the movement references the order (which is what proves payment when the app
  // then PATCHes payment_status), and a second debit for a paid order is refused.
  const wishRef = (row.reference_id && UUID.test(row.reference_id) ? row.reference_id : null) ?? wishOrderIdFromDescription(row.description);
  if (wishRef) {
    const wish = await resolveWishOrderDebit(deps.db, me.profileId, wishRef);
    if (wish.kind === 'already_paid') throw new AppError(409, 'already_paid', 'This order is already paid');
    if (wish.kind === 'charge') {
      const res = await deps.ledger.run('user_wallet', {
        accountId: me.profileId,
        deltaPaise: -wish.amountPaise,
        kind: wish.ledgerKind,
        idempotencyKey: `wish-wallet:${wish.orderId}`,
        createdBy: `user:${me.userId}`,
        description: cleanText(row.description, 200) ?? `Wish order #${wish.orderId}`,
        paymentMethod: 'wallet',
        details: markMirrorable({ service_type: wish.serviceType, order_id: wish.orderId, wish_order_id: wish.orderId }),
        reference: { type: 'wish_celebrity_order', id: wish.orderId },
      });
      return represent(a, 'wallet_transactions', res.historyRowId ? [res.historyRowId] : []);
    }
  }

  if (abs > MAX_DEBIT_PAISE) throw badRequest('Amount too large', 'invalid_amount');
  await deps.limiter.hit('wallet-debit', me.profileId, { limit: 30, windowSec: 600 }, 'Too many payments. Please wait a few minutes.');

  const description = cleanText(row.description, 200);
  const details = safeDetails(row.transaction_details);
  // Identical inserts within a few seconds share one idempotency key, so a double tap or a retried request debits once.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([type, abs, description, row.reference_id ?? null, row.booking_id ?? null, details]))
    .digest('hex')
    .slice(0, 32);
  const dedupeKey = `wtx-debit:${me.profileId}:${fingerprint}`;
  const fresh = uuid();
  const idem = (await deps.kv.set(dedupeKey, fresh, DEBIT_DEDUPE_SEC, true)) ? fresh : ((await deps.kv.get(dedupeKey)) ?? fresh);

  const res = await deps.ledger.run('user_wallet', {
    accountId: me.profileId,
    deltaPaise: -abs,
    kind: type,
    idempotencyKey: `compat:wtx:${idem}`,
    createdBy: `user:${me.userId}`,
    ...(description ? { description } : {}),
    paymentMethod: 'wallet',
    details: { ...details, source: 'client_insert' },
    reference: { type: 'client', id: row.reference_id ?? row.booking_id ?? idem },
  });
  return represent(a, 'wallet_transactions', res.historyRowId ? [res.historyRowId] : []);
}

// ── payment_transactions ─────────────────────────────────────────────────────────────────────────────────────

const PaymentRow = z.object({
  amount: amountField,
  service_type: z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/),
  payment_method: optText(20),
  razorpay_payment_id: optText(100),
  razorpay_order_id: optText(100),
  // The order columns payment_transactions has in production (audit schema); the app sends the first three.
  booking_id: optUuid,
  photo_wish_id: optUuid,
  image_promotion_id: optUuid,
  wish_order_id: optUuid,
  greeting_card_id: optUuid,
  music_generation_id: optUuid,
  voice_call_id: optUuid,
  description: optText(500),
});

const ORDER_COLUMNS = ['booking_id', 'photo_wish_id', 'image_promotion_id', 'wish_order_id', 'greeting_card_id', 'music_generation_id', 'voice_call_id'] as const;

export async function insertPaymentTransaction(a: CustomArgs): Promise<CompatResult> {
  const me = caller(a);
  const row = parseRow(PaymentRow, a.body);
  const abs = Math.abs(fromRupees(row.amount));
  const { deps } = a;

  if (row.razorpay_payment_id) {
    const order = await deps.payments.fulfilledByPayment(row.razorpay_payment_id, me.userId);
    if (!order || order.profile_id !== me.profileId) throw forbidden('Payments are recorded by the server', '42501');
    // verify-razorpay-payment already wrote the record; answer with it instead of writing a second one.
    const existing = await deps.db<{ id: string }[]>`
      select id::text from public.payment_transactions where razorpay_payment_id = ${row.razorpay_payment_id} limit 1`;
    if (existing[0]) return represent(a, 'payment_transactions', [existing[0].id]);
    const written = await insertRow(deps.db, deps.schema, 'payment_transactions', {
      wishme_payment_id: order.wishme_payment_id ?? newWishmePaymentId(),
      user_id: me.profileId,
      amount: amountFor(a, 'payment_transactions', 'amount', Number(order.amount_paise)),
      payment_method: 'razorpay',
      service_type: order.purpose === 'wallet_deposit' ? 'deposit' : order.purpose === 'plan_purchase' ? 'plan_purchase' : row.service_type,
      razorpay_payment_id: row.razorpay_payment_id,
      razorpay_order_id: order.razorpay_order_id,
      description: cleanText(row.description, 200),
      status: 'completed',
      paid_at: new Date().toISOString(),
    });
    return represent(a, 'payment_transactions', written?.id ? [String(written.id)] : []);
  }

  // A wallet-paid service: the domain that charged recorded the ledger movement with metadata.service_type.
  const refColumn = ORDER_COLUMNS.find((c) => row[c]);
  const referenceId = refColumn ? row[refColumn]! : null;
  const kinds = await deps.db<{ kind: string }[]>`
    select distinct kind from wishme.ledger_entries
    where account_kind = 'user_wallet' and account_id = ${me.profileId}
      and metadata ->> 'service_type' = ${row.service_type}
      and coalesce((metadata ->> 'mirrorable')::boolean, false)
      and created_at > now() - make_interval(secs => ${MIRROR_WINDOW_SEC})`;
  const claimed = kinds.length
    ? await claimMirror(deps.db, { accountId: me.profileId, absAmountPaise: abs, kinds: kinds.map((k) => k.kind), table: 'payment_transactions', referenceId })
    : null;
  if (!claimed) throw forbidden('Payments are recorded by the server', '42501');

  const paise = claimed.amountPaise !== 0 ? Math.abs(claimed.amountPaise) : abs;
  const wishmeId = typeof claimed.metadata.wishme_payment_id === 'string' ? claimed.metadata.wishme_payment_id : newWishmePaymentId();
  const written = await insertRow(deps.db, deps.schema, 'payment_transactions', {
    wishme_payment_id: wishmeId,
    user_id: me.profileId,
    amount: amountFor(a, 'payment_transactions', 'amount', paise),
    payment_method: 'wallet',
    service_type: row.service_type,
    ...(refColumn ? { [refColumn]: referenceId } : {}),
    description: cleanText(row.description, 200),
    status: 'completed',
    paid_at: new Date().toISOString(),
  });
  return represent(a, 'payment_transactions', written?.id ? [String(written.id)] : []);
}

// ── payout_requests ──────────────────────────────────────────────────────────────────────────────────────────

const PayoutRow = z.object({
  celebrity_id: z.string().regex(UUID, 'must be a celebrity id'),
  requested_amount: amountField,
  bank_account_number: optText(40),
});

interface BankRow {
  id: string;
  bank_name?: string | null;
  account_number?: string | null;
  ifsc_code?: string | null;
  account_holder_name?: string | null;
  is_default?: boolean | null;
  created_at?: string | null;
}

const digitsOf = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

export async function insertPayoutRequest(a: CustomArgs): Promise<CompatResult> {
  const me = caller(a);
  const row = parseRow(PayoutRow, a.body);
  const payoutId = await requestPayout(a.deps, {
    ...me,
    celebrityIds: a.identity.celebrityIds,
    celebrityId: row.celebrity_id,
    amount: row.requested_amount,
    bankAccountNumber: row.bank_account_number,
  });
  return represent(a, 'payout_requests', [payoutId]);
}

/**
 * Holds `amount` rupees of the celebrity's balance in the ledger and writes the pending payout_requests row, in one
 * transaction. Shared by the PostgREST insert and the celebrity-payout function. Returns the payout request id.
 */
export async function requestPayout(
  deps: CustomArgs['deps'],
  p: {
    userId: string;
    profileId: string;
    celebrityIds: string[];
    celebrityId: string;
    amount: number | string;
    bankAccountNumber?: string | null;
  },
): Promise<string> {
  const me = { userId: p.userId, profileId: p.profileId };
  const celebrityId = p.celebrityId.toLowerCase();
  if (!p.celebrityIds.includes(celebrityId)) {
    throw forbidden('You can only request payouts for your own celebrity account', '42501');
  }
  const paise = positiveAmount(p.amount, { maxRupees: MAX_PAYOUT_RUPEES });
  const amountType = deps.schema.table('payout_requests')?.columns.get('requested_amount')?.type;
  rupeesForColumn(paise, amountType); // whole rupees in production, checked before anything moves

  // The bank snapshot comes from the caller's own saved account, never from the request.
  // bank_details stores the number in account_number (audit schema); WalletTab posts it as bank_account_number.
  const banks = (
    await deps.db<{ j: BankRow }[]>`select to_jsonb(b) as j from public.bank_details b where b.user_id = ${me.profileId}`
  ).map((r) => r.j);
  banks.sort((x, y) => Number(!!y.is_default) - Number(!!x.is_default) || String(y.created_at ?? '').localeCompare(String(x.created_at ?? '')));
  const wanted = digitsOf(p.bankAccountNumber);
  const bank = wanted ? banks.find((b) => digitsOf(b.account_number) === wanted) : banks[0];
  if (!bank) {
    throw badRequest(banks.length ? 'Bank account not found. Please add it first.' : 'No bank details found. Please add bank details first.', 'bank_details_missing');
  }

  // One request at a time for the same amount (double taps); the ledger's row lock serialises the rest.
  const lockKey = `payout:${celebrityId}:${paise}`;
  if (!(await deps.kv.set(lockKey, '1', 15, true))) {
    throw new AppError(409, 'payout_in_progress', 'A payout request for this amount was just submitted');
  }
  await deps.limiter.hit('payout-request', me.profileId, { limit: 10, windowSec: 3600 }, 'Too many payout requests. Please try again later.');

  const payoutId = uuid();
  try {
    await deps.db.begin(async (tx) => {
      await deps.ledger.apply(tx, 'celebrity_earnings', {
        accountId: celebrityId,
        deltaPaise: -paise,
        kind: 'payout_hold',
        idempotencyKey: `payout:${payoutId}`,
        createdBy: `user:${me.userId}`,
        skipHistoryRow: true,
        description: 'Payout request',
        reference: { type: 'payout_request', id: payoutId },
      });
      await insertRow(tx, deps.schema, 'payout_requests', {
        id: payoutId,
        celebrity_id: celebrityId,
        profile_id: me.profileId,
        requested_amount: rupeesForColumn(paise, amountType),
        bank_name: bank.bank_name ?? null,
        bank_account_number: bank.account_number ?? null,
        ifsc_code: bank.ifsc_code ?? null,
        account_holder_name: bank.account_holder_name ?? null,
        status: 'pending',
      });
    });
  } catch (e) {
    await deps.kv.del(lockKey);
    if (e instanceof InsufficientFunds) throw new AppError(400, 'insufficient_balance', 'Amount exceeds your available balance', e.details);
    throw e;
  }
  return payoutId;
}
