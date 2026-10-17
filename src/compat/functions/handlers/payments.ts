/**
 * create-razorpay-order / verify-razorpay-payment. The server prices the order (the client's `amount` is only used for
 * wallet deposits, within limits) and fulfils the payment itself; the response keeps the fields the app reads
 * (`id`, `amount` in paise, `key_id`, `currency`; `success`, `wishme_payment_id`).
 *
 * celebrity-payout: the celebrity dashboard's withdraw button (WalletTab, WithdrawModal). Holds the amount against the
 * caller's own celebrity balance and files a pending payout request that an admin settles (/api/v1/admin/payouts).
 * The response carries `status` ('pending') and the new `available_balance`, the fields the app reads.
 */
import { z } from 'zod';
import { requestPayout } from '../../../domains/accounts/money.js';
import { AppError, forbidden } from '../../../lib/errors.js';
import { defineFunctions, parseBody } from '../registry.js';

const PayoutBody = z.object({
  amount: z.union([z.number().finite(), z.string().trim().min(1).max(20)]),
  account_number: z.string().max(40).nullish(),
});

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
  {
    name: 'celebrity-payout',
    access: 'user',
    rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
    handler: async (c) => {
      const body = parseBody(PayoutBody, c.body);
      const identity = await c.identity();
      if (!identity.profileId) throw forbidden('A profile is required', '42501');
      const celebrityId = identity.celebrityIds[0];
      if (!celebrityId) throw forbidden('Only celebrity accounts can withdraw earnings', '42501');
      const payoutId = await requestPayout(c.deps, {
        userId: c.auth.userId!,
        profileId: identity.profileId,
        celebrityIds: identity.celebrityIds,
        celebrityId,
        amount: body.amount,
        bankAccountNumber: body.account_number,
      });
      const [row] = await c.deps.db<{ available_balance: string | number | null }[]>`
        select available_balance from public.celebrities where id = ${celebrityId}`;
      if (!row) throw new AppError(500, 'internal', 'Celebrity account disappeared');
      return {
        body: { success: true, payout_id: payoutId, status: 'pending', available_balance: Number(row.available_balance ?? 0) },
      };
    },
  },
]);
