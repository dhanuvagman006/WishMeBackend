/**
 * Razorpay payment purposes for the celebrities domain (priced and fulfilled server-side). See ../service.ts.
 *
 * The app pays with Razorpay in one place: a celebrity subscription from app/favorites.tsx, created with
 * `notes: { type: 'celebrity_favorite', celebrity_id, user_id }`. Bookings have no Razorpay path (the wizard's
 * button is a "Coming soon" stub), so none is registered for them.
 */
import type { Deps } from '../../../deps.js';
import { badRequest } from '../../../lib/errors.js';
import { hasActiveSubscription } from '../../celebrities/shared.js';
import { fulfilRazorpaySubscription, RAZORPAY_PURPOSE, SUBSCRIPTION_KIND, subscriptionPricing } from '../../celebrities/subscriptions.js';
import type { Purpose } from '../service.js';

export function subscriptionPurpose(deps: Deps): Purpose {
  return {
    names: [RAZORPAY_PURPOSE, 'celebrity_subscription'],
    serviceType: SUBSCRIPTION_KIND,
    // No plan discount: production's purchase function and the app both use celebrity_favorite_pricing.price as is.
    price: async ({ identity, notes }) => {
      const celebrityId = typeof notes.celebrity_id === 'string' ? notes.celebrity_id : '';
      if (!/^[0-9a-f-]{36}$/i.test(celebrityId)) throw badRequest('celebrity_id is required');
      const { priceRupees } = await subscriptionPricing(deps.db, celebrityId);
      if (identity.profileId && (await hasActiveSubscription(deps.db, identity.profileId, celebrityId))) {
        throw badRequest('You are already subscribed to this celebrity', 'already_subscribed');
      }
      return priceRupees * 100;
    },
    fulfil: async ({ tx, order, paymentId, ledger }) => fulfilRazorpaySubscription(deps, tx, ledger, order, paymentId),
  };
}

export function register(deps: Deps): void {
  deps.payments.registerPurpose(subscriptionPurpose(deps));
}
