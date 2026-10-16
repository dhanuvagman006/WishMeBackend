/**
 * Money safety nets:
 *  - reconcile-orders: orders still 'created' after 15 minutes are checked against Razorpay; a captured payment that
 *    neither the app callback nor the webhook delivered is fulfilled now.
 *  - ledger-invariants: nightly, the ledger's last balance must equal the public balance column; mismatches are logged
 *    at error level (alerting picks them up).
 */
import { QUEUES } from '../queues.js';
import type { ProcessorModule } from '../worker-types.js';
import type { OrderRow } from '../../domains/payments/service.js';

interface RazorpayOrderPayments {
  items: Array<{ id: string; status: string; amount: number; currency: string; order_id: string }>;
}

export const module: ProcessorModule = {
  processors: [
    {
      queue: QUEUES.payments,
      name: 'reconcile-orders',
      concurrency: 1,
      handle: async (_job, deps) => {
        if (!deps.razorpay.configured) return { skipped: 'razorpay not configured' };
        const pending = await deps.db<OrderRow[]>`
          select * from wishme.payment_orders
          where status = 'created' and created_at < now() - interval '15 minutes' and created_at > now() - interval '3 days'
          order by created_at limit 100`;
        let fulfilled = 0;
        for (const o of pending) {
          try {
            const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(o.razorpay_order_id)}/payments`, {
              headers: {
                authorization: `Basic ${Buffer.from(`${deps.env.RAZORPAY_KEY_ID}:${deps.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
              },
              signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) continue;
            const data = (await res.json()) as RazorpayOrderPayments;
            const captured = data.items.find((p) => p.status === 'captured' || p.status === 'authorized');
            if (captured) {
              await deps.payments.fulfil(o, captured.id, captured as never);
              fulfilled++;
            } else if (data.items.length > 0 && data.items.every((p) => p.status === 'failed')) {
              await deps.db`update wishme.payment_orders set status = 'failed', updated_at = now() where razorpay_order_id = ${o.razorpay_order_id}`;
            }
          } catch (e) {
            deps.log.error({ err: (e as Error).message, orderId: o.razorpay_order_id }, 'reconciliation failed for order');
          }
        }
        return { checked: pending.length, fulfilled };
      },
    },
    {
      queue: QUEUES.payments,
      name: 'ledger-invariants',
      concurrency: 1,
      handle: async (_job, deps) => {
        const mismatches = await deps.ledger.verifyInvariants();
        if (mismatches.length) deps.log.error({ mismatches: mismatches.slice(0, 50), count: mismatches.length }, 'LEDGER INVARIANT MISMATCH');
        return { mismatches: mismatches.length };
      },
    },
  ],
  repeatables: [
    { queue: QUEUES.payments, name: 'reconcile-orders', cron: '*/10 * * * *' },
    { queue: QUEUES.payments, name: 'ledger-invariants', cron: '30 21 * * *' },
  ],
};
