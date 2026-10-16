/**
 * Wish-a-celebrity orders (wish_celebrity_orders). The app creates the order, pays (wallet debit row or Razorpay) and
 * then PATCHes the order to "paid" itself; here the server owns every money field and state change:
 *
 *  - insert: the price is the celebrity's service_prices.general_wish (the app's plan discount state is never set, so
 *    no discount applies); amount_paid / discount_* / payment_status / status from the client are ignored.
 *  - "paid": accepted only with proof: wallet debits referencing the order (wishme.ledger_entries.reference_id) that
 *    cover the server price, or a fulfilled Razorpay order for it (the Razorpay purpose also marks it paid itself).
 *  - "sent": only for paid upload-card / upload-video orders (the app's own transition after send-wish-thankyou-dm).
 *  - delete: only unpaid orders without any wallet debit (the app's rollback after a failed or cancelled payment).
 */
import type { Queryable } from '../../lib/db.js';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import { fromRupees } from '../../lib/money.js';
import { celebrityPricePaise, orderableCelebrity } from './money.js';

export const WISH_ORDER_PURPOSE = 'wish_order';

export interface WishOrderRow {
  id: string;
  user_id: string;
  celebrity_id: string;
  amount_paid: string | null;
  payment_status: string | null;
  payment_method: string | null;
  status: string | null;
  card_generation_type: string | null;
  generation_attempts: number | null;
}

/** Server price of a wish to this celebrity (paise). 400 when the celebrity has no wish price. */
export async function wishOrderPricePaise(q: Queryable, celebrityId: string): Promise<number> {
  const celeb = await orderableCelebrity(q, celebrityId);
  const price = celebrityPricePaise(celeb, 'general_wish');
  if (price <= 0) throw badRequest('This celebrity is not accepting wishes right now', 'celebrity_unavailable');
  return price;
}

export async function loadOwnOrder(q: Queryable, orderId: string, profileId: string, lock = false): Promise<WishOrderRow | null> {
  const rows = lock
    ? await q<WishOrderRow[]>`
        select id::text, user_id::text, celebrity_id::text, amount_paid::text, payment_status, payment_method, status, card_generation_type, generation_attempts
        from public.wish_celebrity_orders where id = ${orderId}::uuid and user_id = ${profileId}::uuid for update`
    : await q<WishOrderRow[]>`
        select id::text, user_id::text, celebrity_id::text, amount_paid::text, payment_status, payment_method, status, card_generation_type, generation_attempts
        from public.wish_celebrity_orders where id = ${orderId}::uuid and user_id = ${profileId}::uuid`;
  return rows[0] ?? null;
}

export const isPaid = (o: Pick<WishOrderRow, 'payment_status'>) => o.payment_status === 'completed';

/**
 * Price the order is held to: the amount the server recorded at creation (amount_paid, INTEGER rupees).
 * ASSUMPTION: unpaid orders created through the old Supabase path (client-written amount_paid) are rare enough at
 * cutover of rest:wish_celebrity_orders that holding them to their recorded amount is acceptable.
 */
export function orderPricePaise(o: WishOrderRow): number {
  return o.amount_paid ? fromRupees(o.amount_paid) : 0;
}

/** Net wallet movement referencing the order for this user (negative = paid), in paise. */
async function walletNetPaise(q: Queryable, profileId: string, orderId: string): Promise<{ net: number; entries: number }> {
  const rows = await q<{ net: string; n: number }[]>`
    select coalesce(sum(amount_paise), 0)::text as net, count(*)::int as n from wishme.ledger_entries
    where account_kind = 'user_wallet' and account_id = ${profileId}::uuid and reference_id = ${orderId}`;
  return { net: Number(rows[0]?.net ?? 0), entries: rows[0]?.n ?? 0 };
}

/** How the order was paid, if the server can prove it; null otherwise. */
export async function paymentProof(q: Queryable, order: WishOrderRow, userId: string): Promise<'wallet' | 'razorpay' | null> {
  const price = orderPricePaise(order);
  if (price > 0) {
    const w = await walletNetPaise(q, order.user_id, order.id);
    if (w.net <= -price) return 'wallet';
  }
  const rzp = await q<{ ok: number }[]>`
    select 1 as ok from wishme.payment_orders
    where user_id = ${userId}::uuid and purpose = ${WISH_ORDER_PURPOSE} and status = 'fulfilled' and notes ->> 'orderId' = ${order.id}
    limit 1`;
  return rzp[0] ? 'razorpay' : null;
}

/**
 * Marks an order paid (idempotent). Only payment_status changes: the table's status CHECK allows
 * pending | generated | sent | failed, so "paid" lives in payment_status alone. Flipping payment_status to 'completed'
 * fires the production triggers credit_celebrity_on_wish_order_complete (celebrity earnings from amount_paid) and
 * process_wish_celebrity_referral_commission, which is exactly why it needs proof of payment.
 */
export async function markOrderPaid(
  q: Queryable,
  orderId: string,
  method: 'wallet' | 'razorpay',
  extra: { amountPaise?: number; razorpayOrderId?: string; razorpayPaymentId?: string; wishmePaymentId?: string } = {},
): Promise<void> {
  await q`
    update public.wish_celebrity_orders
    set payment_status = 'completed', payment_method = ${method},
        amount_paid = coalesce(${extra.amountPaise !== undefined ? Math.round(extra.amountPaise / 100) : null}::integer, amount_paid),
        razorpay_order_id = coalesce(${extra.razorpayOrderId ?? null}::text, razorpay_order_id),
        razorpay_payment_id = coalesce(${extra.razorpayPaymentId ?? null}::text, razorpay_payment_id),
        wishme_payment_id = coalesce(${extra.wishmePaymentId ?? null}::text, wishme_payment_id),
        updated_at = now()
    where id = ${orderId}::uuid and coalesce(payment_status, 'pending') <> 'completed'`;
}

/** Applies the app's PATCH body to an order the caller owns (locked by the caller's transaction). */
export async function applyOrderPatch(
  q: Queryable,
  order: WishOrderRow,
  userId: string,
  body: { status?: string; payment_status?: string; payment_method?: string },
): Promise<void> {
  const wantsPaid = body.payment_status === 'completed' || body.status === 'paid';
  if (wantsPaid && !isPaid(order)) {
    const proof = await paymentProof(q, order, userId);
    if (!proof) throw new AppError(403, '42501', 'Payment for this order has not been received');
    await markOrderPaid(q, order.id, proof);
    order = { ...order, payment_status: 'completed' };
  }
  if (body.status === 'sent') {
    // The app's own transition for upload-card / upload-video orders after send-wish-thankyou-dm. No trigger moves
    // money on status (the earnings and commission triggers key on payment_status), so a paid order may be marked sent.
    const upload = order.card_generation_type === 'upload-card' || order.card_generation_type === 'upload-video';
    if (!isPaid(order) || !upload) throw new AppError(403, '42501', 'This order cannot be marked as sent');
    await q`update public.wish_celebrity_orders set status = 'sent', completed_at = coalesce(completed_at, now()), updated_at = now()
            where id = ${order.id}::uuid and coalesce(status, 'pending') in ('pending', 'generated', 'sent')`;
  } else if (body.status !== undefined && body.status !== 'paid' && body.status !== 'pending') {
    // 'paid' is what the app sends after paying; the column cannot hold it, so it is expressed by payment_status above.
    throw new AppError(403, '42501', `status "${body.status}" is set by the server`);
  }
  if (body.payment_method !== undefined && !isPaid(order)) {
    await q`update public.wish_celebrity_orders set payment_method = ${body.payment_method}, updated_at = now() where id = ${order.id}::uuid`;
  }
}

/** Deletes an unpaid order without wallet movements (the app's rollback). Returns the number deleted. */
export async function deleteUnpaidOrder(q: Queryable, orderId: string, profileId: string): Promise<number> {
  const order = await loadOwnOrder(q, orderId, profileId, true);
  if (!order || isPaid(order)) return 0;
  const w = await walletNetPaise(q, profileId, orderId);
  if (w.entries > 0) return 0;
  const rzp = await q<{ ok: number }[]>`
    select 1 as ok from wishme.payment_orders where purpose = ${WISH_ORDER_PURPOSE} and notes ->> 'orderId' = ${orderId} and status in ('paid', 'fulfilled') limit 1`;
  if (rzp[0]) return 0;
  const del = await q`delete from public.wish_celebrity_orders where id = ${orderId}::uuid and user_id = ${profileId}::uuid`;
  return del.count;
}

export type WishOrderDebit =
  | { kind: 'not_wish_order' }
  | { kind: 'already_paid'; orderId: string }
  | { kind: 'charge'; orderId: string; amountPaise: number; ledgerKind: string; serviceType: string };

/**
 * For the wallet_transactions insert handler (accounts domain): decides what a client wallet debit that names a wish
 * order may do. The server price replaces the client's amount; a second debit for a paid order is refused.
 * `referenceId` is the row's reference_id, or the id parsed from a description "Wish order #<uuid> ...".
 */
export async function resolveWishOrderDebit(q: Queryable, profileId: string, referenceId: string | null | undefined): Promise<WishOrderDebit> {
  if (!referenceId || !/^[0-9a-f-]{36}$/i.test(referenceId)) return { kind: 'not_wish_order' };
  const order = await loadOwnOrder(q, referenceId, profileId);
  if (!order) return { kind: 'not_wish_order' };
  if (isPaid(order)) return { kind: 'already_paid', orderId: order.id };
  const w = await walletNetPaise(q, profileId, order.id);
  if (w.net < 0) return { kind: 'already_paid', orderId: order.id };
  return { kind: 'charge', orderId: order.id, amountPaise: orderPricePaise(order), ledgerKind: 'greeting_card_generation', serviceType: 'wish_order' };
}

/** The wish order id mentioned in the app's debit description ("Wish order #<uuid> for ..."), if any. */
export function wishOrderIdFromDescription(description: unknown): string | null {
  if (typeof description !== 'string') return null;
  return /Wish order #([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(description)?.[1] ?? null;
}

/**
 * Razorpay purpose price: the celebrity's current wish price (what the app shows). The order's own amount_paid is not
 * trusted here because orders created through the old Supabase path carry a client-written amount.
 */
export async function priceForRazorpay(q: Queryable, orderId: unknown, profileId: string): Promise<number> {
  if (typeof orderId !== 'string' || !/^[0-9a-f-]{36}$/i.test(orderId)) throw badRequest('orderId is required');
  const order = await loadOwnOrder(q, orderId, profileId);
  if (!order) throw new AppError(404, 'not_found', 'Wish order not found');
  if (isPaid(order)) throw conflict('This order is already paid', 'already_paid');
  return wishOrderPricePaise(q, order.celebrity_id);
}
