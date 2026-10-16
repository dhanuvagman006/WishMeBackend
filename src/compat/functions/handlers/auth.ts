/**
 * send-email-otp / verify-email-otp, as the app calls them today (anon key, { email } and { email, otp }).
 * Status codes and message words are part of the contract (see auth/otp.ts and auth/service.ts).
 * Verification is bound to the following /auth/v1/signup on the server side.
 */
import { defineFunctions } from '../registry.js';

export const functions = defineFunctions([
  {
    name: 'send-email-otp',
    access: 'anon',
    handler: async (c) => {
      const body = (c.body ?? {}) as { email?: unknown; purpose?: unknown };
      const purpose = body.purpose === 'reset' ? 'reset' : 'signup';
      await c.deps.auth.sendOtp(body.email, purpose, { ip: c.ip });
      return { body: { success: true, message: 'OTP sent to your email' } };
    },
  },
  {
    name: 'verify-email-otp',
    access: 'anon',
    handler: async (c) => {
      const body = (c.body ?? {}) as { email?: unknown; otp?: unknown; purpose?: unknown };
      const purpose = body.purpose === 'reset' ? 'reset' : 'signup';
      await c.deps.auth.verifyOtp(body.email, body.otp, purpose, { ip: c.ip });
      return { body: { success: true, verified: true, message: 'Email verified' } };
    },
  },
]);
