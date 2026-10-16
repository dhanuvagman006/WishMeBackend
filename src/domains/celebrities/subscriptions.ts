/**
 * Celebrity subscriptions ("favourites"): `celebrity_favorites` rows with status 'active'.
 *
 *  - Wallet: POST /rest/v1/rpc/purchase_celebrity_subscription with p_payment_method 'wallet' prices the subscription
 *    from celebrity_favorite_pricing, debits the wallet through the ledger, activates the row and pays the
 *    celebrity's commission, atomically.
 *  - Razorpay: create-razorpay-order with notes.type 'celebrity_favorite' (purpose registered in
 *    domains/payments/purposes/celebrities.ts) is fulfilled by the server when Razorpay confirms the payment
 *    (verify-razorpay-payment or the webhook). The app then calls the RPC with 'razorpay' and no payment id; the RPC
 *    only reports whether that fulfilment happened. (Production's SQL function activated the subscription and paid
 *    commissions for any method other than 'wallet' without any payment: audit finding 3.)
 *
 * Kept from production's function (audit, 16 Oct 2026): error words ("Already subscribed to this celebrity",
 * "Subscription not available for this celebrity", "Price mismatch. Expected X, got Y", "Insufficient wallet
 * balance"), the response { success, favorite_id, celebrity_commission, platform_fee }, recorded commissions
 * (referrer = floor(price × referrer %), celebrity gross = floor(price × celebrity %)), the celebrity's earning row in
 * celebrity_wallet_transactions net of TDS (tds_rate_with_pan / tds_rate_without_pan, default 10 / 20 %) and the
 * matching total_earnings / available_balance credit. Referral commissions are not paid here: production's
 * trigger_celebrity_favorite_referral_commission pays them when the favourite row is inserted.
 */
import { z } from 'zod';
import type { AuthContext } from '../../auth/context.js';
import type { RpcContext, CompatResult } from '../../compat/postgrest/policy.js';
import type { Deps } from '../../deps.js';
import type { Db, Tx } from '../../lib/db.js';
import { AppError, badRequest, isAppError } from '../../lib/errors.js';
import { toRupeesNumber } from '../../lib/money.js';
import { uuid } from '../../lib/crypto.js';
import { settingValue } from '../pricing.js';
import type { Ledger } from '../wallet/ledger.js';
import { markMirrorable } from '../wallet/mirrors.js';
import { insertRow, requireProfile, updateRow } from './compat.js';
import { availableCelebrity } from './shared.js';

export const SUBSCRIPTION_KIND = 'celebrity_subscription';
export const RAZORPAY_PURPOSE = 'celebrity_favorite';

interface PricingRow {
  price: number;
  referrer_commission_percentage: number | null;
  celebrity_commission_percentage: number | null;
}

/** The enabled subscription price (whole rupees) of an available celebrity, or a 400 with production's words. */
export async function subscriptionPricing(q: Db | Tx, celebrityId: string): Promise<{ celebrity: { id: string; name: string; profileId: string | null }; priceRupees: number; pricing: PricingRow }> {
  const celeb = await availableCelebrity(q, celebrityId);
  const rows = celeb
    ? await q<PricingRow[]>`
        select price, referrer_commission_percentage, celebrity_commission_percentage
        from public.celebrity_favorite_pricing where celebrity_id = ${celebrityId} and is_enabled is true limit 1`
    : [];
  const pricing = rows[0];
  if (!celeb || !pricing || !(pricing.price > 0)) throw badRequest('Subscription not available for this celebrity', 'subscription_unavailable');
  return { celebrity: { id: celeb.id, name: celeb.name, profileId: celeb.profile_id }, priceRupees: pricing.price, pricing };
}

function pct(v: number | null, fallback: number): number {
  const n = Number(v ?? fallback);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 100) : fallback;
}

export interface Commission {
  referrer: number;
  celebrityGross: number;
  tdsRate: number;
  tds: number;
  celebrityNet: number;
  platformFee: number;
}

/** Production's split of a subscription price (whole rupees, floors as in the SQL function). */
export async function subscriptionCommission(q: Db | Tx, priceRupees: number, pricing: PricingRow, celebrityProfileId: string | null): Promise<Commission> {
  const referrer = Math.floor((priceRupees * pct(pricing.referrer_commission_percentage, 10)) / 100);
  const celebrityGross = Math.floor((priceRupees * pct(pricing.celebrity_commission_percentage, 5)) / 100);
  const panVerified = celebrityProfileId
    ? !!(await q<{ pan_verified: boolean | null }[]>`select pan_verified from public.profiles where id = ${celebrityProfileId}`)[0]?.pan_verified
    : false;
  const setting = Number.parseInt(String((await settingValue(q, panVerified ? 'tds_rate_with_pan' : 'tds_rate_without_pan')) ?? ''), 10);
  const tdsRate = Number.isFinite(setting) ? Math.min(Math.max(setting, 0), 100) : panVerified ? 10 : 20;
  const tds = Math.floor((celebrityGross * tdsRate) / 100);
  return { referrer, celebrityGross, tdsRate, tds, celebrityNet: celebrityGross - tds, platformFee: priceRupees - celebrityGross };
}

interface FavouriteRow {
  id: string;
  status: string;
}

async function lockedFavourite(tx: Tx, profileId: string, celebrityId: string): Promise<FavouriteRow | null> {
  const rows = await tx<FavouriteRow[]>`
    select id::text, status from public.celebrity_favorites
    where user_id = ${profileId} and celebrity_id = ${celebrityId} for update`;
  return rows[0] ?? null;
}

/**
 * Creates the subscription row, or re-activates a cancelled one (the table is unique on user and celebrity, which
 * made re-subscribing fail in production). Subscriptions are lifetime: FollowersTab shows a null
 * subscription_expires_at as "Lifetime", and production's function never set one.
 */
async function activate(
  deps: Deps,
  tx: Tx,
  input: { existing: FavouriteRow | null; favId: string; profileId: string; celebrityId: string; priceRupees: number; commission: Commission; method: 'wallet' | 'razorpay' },
): Promise<void> {
  const row = {
    status: 'active',
    price_paid: input.priceRupees,
    referrer_commission: input.commission.referrer,
    celebrity_commission: input.commission.celebrityGross,
    payment_method: input.method,
    subscription_start_date: new Date().toISOString(),
    subscription_expires_at: null,
    cancelled_at: null,
    auto_renew: false,
  };
  if (input.existing) await updateRow(deps, tx, 'celebrity_favorites', input.existing.id, row);
  else await insertRow(deps, tx, 'celebrity_favorites', { id: input.favId, user_id: input.profileId, celebrity_id: input.celebrityId, ...row });
}

/** The celebrity's earning: history row plus balance credit through the ledger (idempotent per subscription purchase). */
async function payCelebrity(deps: Deps, tx: Tx, ledger: Ledger, input: { celebrityId: string; favId: string; purchaseKey: string; pricing: PricingRow; commission: Commission }): Promise<void> {
  const c = input.commission;
  if (c.celebrityNet <= 0) return;
  const move = await ledger.apply(tx, 'celebrity_earnings', {
    accountId: input.celebrityId,
    deltaPaise: c.celebrityNet * 100,
    kind: 'subscription_commission',
    idempotencyKey: `${input.purchaseKey}:celebrity`,
    createdBy: 'system:subscription',
    description: 'Subscription commission from user',
    details: { favorite_id: input.favId, gross: c.celebrityGross, tds: c.tds, tds_rate: c.tdsRate },
    reference: { type: 'celebrity_favorite', id: input.favId },
    skipHistoryRow: true,
  });
  if (move.alreadyApplied) return;
  await insertRow(deps, tx, 'celebrity_wallet_transactions', {
    celebrity_id: input.celebrityId,
    booking_id: input.favId,
    order_type: 'subscription',
    transaction_type: 'earning',
    amount: c.celebrityNet,
    gross_amount: c.celebrityGross,
    tds_percentage: c.tdsRate,
    tds_amount: c.tds,
    commission_percentage: pct(input.pricing.celebrity_commission_percentage, 5),
    platform_fee: c.platformFee,
    description: 'Subscription commission from user',
    status: 'completed',
  });
  await tx`update public.celebrities set total_earnings = coalesce(total_earnings, 0) + ${c.celebrityNet} where id = ${input.celebrityId}`;
}

const Args = z.object({
  p_celebrity_id: z.string().uuid(),
  p_price: z.number().int().optional().nullable(),
  p_payment_method: z.enum(['wallet', 'razorpay']).default('wallet'),
});

/** The RPC's error shape: SubscribeSheet reads `error` (also via parseApiError), favorites.tsx reads `message`. */
function failure(e: AppError): CompatResult {
  return { status: e.status, body: { success: false, error: e.message, message: e.message, code: e.code, details: e.details ?? null, hint: e.hint ?? null } };
}

/** POST /rest/v1/rpc/purchase_celebrity_subscription. */
export async function purchaseSubscription(c: RpcContext): Promise<CompatResult> {
  try {
    const profileId = requireProfile(c.auth, c.identity);
    const r = Args.safeParse(c.args);
    if (!r.success) throw badRequest(`Invalid ${r.error.issues[0]?.path.join('.') || 'arguments'}: ${r.error.issues[0]?.message}`, 'invalid_request');
    await c.deps.limiter.hit('celebrity-subscription', profileId, { limit: 10, windowSec: 600 }, 'Too many attempts. Please try again in a few minutes.');
    const body = r.data.p_payment_method === 'wallet'
      ? await payFromWallet(c.deps, c.auth, profileId, r.data.p_celebrity_id, r.data.p_price ?? null)
      : await confirmRazorpay(c.deps, c.auth, profileId, r.data.p_celebrity_id);
    return { status: 200, body };
  } catch (e) {
    if (isAppError(e) && e.status < 500) return failure(e);
    throw e;
  }
}

async function payFromWallet(deps: Deps, auth: AuthContext, profileId: string, celebrityId: string, clientPrice: number | null) {
  return deps.db.begin(async (tx) => {
    // Serialise this user's purchases first, so a double tap sees the first subscription.
    await tx`select id from public.profiles where id = ${profileId} for update`;
    const existing = await lockedFavourite(tx, profileId, celebrityId);
    if (existing?.status === 'active') throw badRequest('Already subscribed to this celebrity', 'already_subscribed');
    const { celebrity, priceRupees, pricing } = await subscriptionPricing(tx, celebrityId);
    if (clientPrice !== null && clientPrice !== priceRupees) {
      throw badRequest(`Price mismatch. Expected ${priceRupees}, got ${clientPrice}`, 'price_mismatch');
    }
    const favId = existing?.id ?? uuid();
    // A fresh key per purchase: re-subscribing after a cancellation must charge again; double taps are stopped above.
    const purchaseKey = `celebrity_subscription:${favId}:${uuid()}`;
    const move = await deps.ledger.apply(tx, 'user_wallet', {
      accountId: profileId,
      deltaPaise: -priceRupees * 100,
      kind: SUBSCRIPTION_KIND,
      idempotencyKey: purchaseKey,
      createdBy: `user:${auth.userId}`,
      paymentMethod: 'wallet',
      description: 'Subscription to celebrity',
      details: markMirrorable({ service_type: SUBSCRIPTION_KIND, order_id: favId, celebrity_id: celebrityId }),
      reference: { type: 'celebrity_favorite', id: favId },
    });
    const commission = await subscriptionCommission(tx, priceRupees, pricing, celebrity.profileId);
    await activate(deps, tx, { existing, favId, profileId, celebrityId, priceRupees, commission, method: 'wallet' });
    await payCelebrity(deps, tx, deps.ledger, { celebrityId, favId, purchaseKey, pricing, commission });
    return {
      success: true,
      favorite_id: favId,
      celebrity_commission: commission.celebrityNet,
      platform_fee: commission.platformFee,
      price_paid: priceRupees,
      payment_method: 'wallet',
      new_balance: toRupeesNumber(move.balanceAfterPaise),
    };
  });
}

/** How long the RPC waits for Razorpay's confirmation (webhook) to land before telling the app to check back. */
export const RAZORPAY_CONFIRM_WAIT_MS = 8_000;

async function confirmRazorpay(deps: Deps, auth: AuthContext, profileId: string, celebrityId: string) {
  const deadline = Date.now() + RAZORPAY_CONFIRM_WAIT_MS;
  for (;;) {
    const orders = await deps.db<{ status: string; fulfilment: Record<string, unknown> | null }[]>`
      select status, fulfilment from wishme.payment_orders
      where user_id = ${auth.userId} and purpose = ${RAZORPAY_PURPOSE} and notes ->> 'celebrity_id' = ${celebrityId}
        and created_at > now() - interval '1 day'
      order by created_at desc`;
    const done = orders.find((o) => o.status === 'fulfilled' && o.fulfilment?.favorite_id);
    if (done) {
      const f = done.fulfilment!;
      return { success: true, favorite_id: f.favorite_id, celebrity_commission: f.celebrity_commission ?? null, platform_fee: f.platform_fee ?? null, payment_method: 'razorpay' };
    }
    if (!orders.some((o) => o.status === 'created' || o.status === 'paid')) {
      throw badRequest('No Razorpay payment was found for this subscription', 'payment_not_found');
    }
    if (Date.now() >= deadline) {
      throw new AppError(409, 'payment_pending', 'We are still confirming your payment with Razorpay. Your subscription will activate automatically once it is confirmed.');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Razorpay fulfilment (inside the payment service's transaction): activates the subscription, pays the celebrity and
 * records the payment in the user's history as a record-only movement. If the user subscribed some other way while
 * paying, the money goes back to the wallet instead of being kept for nothing.
 */
export async function fulfilRazorpaySubscription(
  deps: Deps,
  tx: Tx,
  ledger: Ledger,
  order: { razorpay_order_id: string; profile_id: string | null; notes: Record<string, unknown>; amountPaise: number },
  paymentId: string,
): Promise<Record<string, unknown>> {
  const profileId = order.profile_id;
  const celebrityId = typeof order.notes.celebrity_id === 'string' ? order.notes.celebrity_id : null;
  if (!profileId || !celebrityId) throw new AppError(500, 'order_incomplete', 'Subscription order is missing its user or celebrity');
  await tx`select id from public.profiles where id = ${profileId} for update`;
  const existing = await lockedFavourite(tx, profileId, celebrityId);
  const priceRupees = order.amountPaise / 100;
  if (existing?.status === 'active') {
    const refund = await ledger.apply(tx, 'user_wallet', {
      accountId: profileId,
      deltaPaise: order.amountPaise,
      kind: 'refund',
      idempotencyKey: `rzp:${paymentId}`,
      createdBy: 'system:razorpay',
      paymentMethod: 'admin',
      description: 'Refund: already subscribed to this celebrity',
      details: { service_type: SUBSCRIPTION_KIND, celebrity_id: celebrityId, razorpay_order_id: order.razorpay_order_id, razorpay_payment_id: paymentId },
      reference: { type: 'razorpay_payment', id: paymentId },
    });
    deps.log.warn({ paymentId, profileId, celebrityId }, 'duplicate subscription payment refunded to wallet');
    return { already_subscribed: true, refunded_to_wallet: priceRupees, new_balance: toRupeesNumber(refund.balanceAfterPaise) };
  }
  const pricing = (await tx<PricingRow[]>`
    select price, referrer_commission_percentage, celebrity_commission_percentage
    from public.celebrity_favorite_pricing where celebrity_id = ${celebrityId} limit 1`)[0] ?? { price: priceRupees, referrer_commission_percentage: null, celebrity_commission_percentage: null };
  const celebProfile = (await tx<{ profile_id: string | null }[]>`select profile_id::text from public.celebrities where id = ${celebrityId}`)[0]?.profile_id ?? null;
  const favId = existing?.id ?? uuid();
  const purchaseKey = `rzp:${paymentId}`;
  const move = await ledger.apply(tx, 'user_wallet', {
    accountId: profileId,
    deltaPaise: 0,
    displayPaise: order.amountPaise,
    kind: SUBSCRIPTION_KIND,
    idempotencyKey: purchaseKey,
    createdBy: 'system:razorpay',
    paymentMethod: 'razorpay',
    description: 'Subscription to celebrity',
    details: markMirrorable({ service_type: SUBSCRIPTION_KIND, order_id: favId, celebrity_id: celebrityId, razorpay_order_id: order.razorpay_order_id, razorpay_payment_id: paymentId }),
    reference: { type: 'razorpay_payment', id: paymentId },
  });
  const commission = await subscriptionCommission(tx, priceRupees, pricing, celebProfile);
  await activate(deps, tx, { existing, favId, profileId, celebrityId, priceRupees, commission, method: 'razorpay' });
  await payCelebrity(deps, tx, ledger, { celebrityId, favId, purchaseKey, pricing, commission });
  return { favorite_id: favId, celebrity_id: celebrityId, celebrity_commission: commission.celebrityNet, platform_fee: commission.platformFee, wallet_transaction_id: move.historyRowId };
}
