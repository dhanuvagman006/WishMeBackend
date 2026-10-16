/**
 * Razorpay payment purposes for the content domain (priced and fulfilled server-side). See ../service.ts.
 *
 * Wish-a-celebrity orders paid with Razorpay (app/wish-booking/[id].tsx, app/wish-celebrity-occasion/[id].tsx). The app
 * sends `{ amount: price * 100, receipt: 'WISH-<orderId>', notes: { orderId } }` with no notes.type, then
 * verify-razorpay-payment with `{ orderId, orderType: 'wish' }`. The price is the celebrity's wish price (never the
 * client amount); fulfilment marks the order paid inside the fulfilment transaction, as the deployed
 * verify-razorpay-payment did (payment_status 'completed', razorpay ids, wishme_payment_id), and records a
 * record-only ledger entry referencing the order. payment_transactions.service_type is 'wish_order' (as deployed).
 */
import type { Deps } from '../../../deps.js';
import { AppError } from '../../../lib/errors.js';
import { WISH_ORDER_PURPOSE, loadOwnOrder, markOrderPaid, priceForRazorpay } from '../../content/wish-orders.js';

export function register(deps: Deps): void {
  deps.payments.registerPurpose({
    // 'wish' is the app's verify orderType; the service must map a typeless order with notes.orderId (or a
    // 'WISH-' receipt) to 'wish_order' (see the content report).
    names: [WISH_ORDER_PURPOSE, 'wish', 'wish_celebrity_order'],
    serviceType: 'wish_order',
    price: async ({ identity, notes }) => {
      if (!identity.profileId) throw new AppError(403, 'forbidden', 'A profile is required to pay');
      return priceForRazorpay(deps.db, notes.orderId, identity.profileId);
    },
    fulfil: async ({ tx, order, paymentId, wishmePaymentId, ledger }) => {
      const orderId = String(order.notes.orderId ?? '');
      const wish = order.profile_id ? await loadOwnOrder(tx, orderId, order.profile_id, true) : null;
      if (!wish) {
        // The money is captured either way: record it so reconciliation / support can refund, but do not fail the
        // fulfilment (that would leave a captured payment unfulfilled forever).
        deps.log.error({ orderId, razorpayOrderId: order.razorpay_order_id }, 'paid wish order not found');
      } else {
        await markOrderPaid(tx, wish.id, 'razorpay', {
          amountPaise: order.amountPaise,
          razorpayOrderId: order.razorpay_order_id,
          razorpayPaymentId: paymentId,
          wishmePaymentId,
        });
      }
      await ledger.apply(tx, 'user_wallet', {
        accountId: order.profile_id!,
        deltaPaise: 0,
        displayPaise: order.amountPaise,
        kind: 'wish_order',
        idempotencyKey: `rzp:${paymentId}`,
        createdBy: 'system:razorpay',
        paymentMethod: 'razorpay',
        skipHistoryRow: true,
        details: { service_type: 'wish_order', order_id: orderId, razorpay_order_id: order.razorpay_order_id, razorpay_payment_id: paymentId },
        reference: { type: 'wish_celebrity_order', id: orderId },
      });
      return { wish_order_id: orderId };
    },
  });
}
