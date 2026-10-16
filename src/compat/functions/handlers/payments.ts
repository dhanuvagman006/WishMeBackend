/**
 * create-razorpay-order / verify-razorpay-payment. The server prices the order (the client's `amount` is only used for
 * wallet deposits, within limits) and fulfils the payment itself; the response keeps the fields the app reads
 * (`id`, `amount` in paise, `key_id`, `currency`; `success`, `wishme_payment_id`).
 */
import { defineFunctions } from '../registry.js';

export const functions = defineFunctions([
  {
    name: 'create-razorpay-order',
    access: 'user',
    rateLimit: { limit: 30, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const order = await c.deps.payments.createOrder(c.auth, await c.identity(), (c.body ?? {}) as Record<string, unknown>);
      return { body: order };
    },
  },
  {
    name: 'verify-razorpay-payment',
    access: 'user',
    rateLimit: { limit: 60, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const result = await c.deps.payments.verify(c.auth, (c.body ?? {}) as Record<string, unknown>);
      await c.deps.resolver.forgetIdentity(c.auth.userId!);
      return { body: result };
    },
  },
]);
