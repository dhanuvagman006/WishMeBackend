/**
 * /api/v1 — the clean API for new app code, plus operational endpoints. Responses are typed and resource-oriented;
 * errors are { error: { code, message } }. Everything here takes the user from the bearer token; no route accepts an
 * owner id from the client.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser, type AuthContext } from '../../auth/context.js';
import { clientMeta } from '../../compat/common.js';
import type { Deps } from '../../deps.js';
import { pingDb } from '../../lib/db.js';
import { AppError, badRequest, unauthorized } from '../../lib/errors.js';
import { registry } from '../../lib/metrics.js';
import { positiveAmount, toRupeesNumber } from '../../lib/money.js';
import { safeEqual, uuid } from '../../lib/crypto.js';
import { parseBody } from '../../compat/functions/registry.js';
import type { RealtimeHub } from '../../compat/realtime/hub.js';
import { registerAdmin } from './admin.js';

async function userOf(deps: Deps, req: FastifyRequest): Promise<AuthContext & { userId: string }> {
  const h = req.headers.authorization;
  const token = typeof h === 'string' ? /^Bearer\s+(.+)$/i.exec(h)?.[1] : undefined;
  if (!token) throw unauthorized();
  const auth = await deps.resolver.resolve(token);
  requireUser(auth);
  return auth;
}

export function registerV1(app: FastifyInstance, deps: Deps, hub: RealtimeHub | null): void {
  registerAdmin(app, deps);

  // ── operations ─────────────────────────────────────────────────────────────────────────────────────────────
  app.get('/api/healthz', async () => ({ status: 'ok' }));

  app.get('/api/readyz', async (_req, reply) => {
    const [db, kv] = await Promise.all([pingDb(deps.db), deps.kv.ping()]);
    const schema = deps.schema.isLoaded;
    const ok = db && kv && schema;
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', db, redis: kv, schema, realtimeSockets: hub?.size ?? 0 });
  });

  app.get('/metrics', async (req, reply) => {
    const token = deps.env.METRICS_TOKEN;
    const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !safeEqual(given, token)) return reply.code(404).send();
    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });

  app.get('/api/v1/config', async () => ({
    minVersion: deps.env.APP_MIN_VERSION,
    recommendedVersion: deps.env.APP_RECOMMENDED_VERSION,
    routes: deps.modes.snapshot(),
    serverTime: new Date().toISOString(),
  }));

  // ── webhooks ───────────────────────────────────────────────────────────────────────────────────────────────
  // Raw body required for the signature: this route's parser keeps the bytes (see app.ts).
  app.post('/api/v1/webhooks/razorpay', { config: { rawBody: true } }, async (req) => {
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw)) throw badRequest('Expected a raw body');
    const sig = req.headers['x-razorpay-signature'];
    const eventId = req.headers['x-razorpay-event-id'];
    return deps.payments.handleWebhook(raw, typeof sig === 'string' ? sig : undefined, typeof eventId === 'string' ? eventId : undefined);
  });

  // ── auth ───────────────────────────────────────────────────────────────────────────────────────────────────
  app.post('/api/v1/auth/otp', async (req, reply) => {
    const b = parseBody(z.object({ email: z.string(), purpose: z.enum(['signup', 'reset']).default('signup') }), req.body);
    await deps.auth.sendOtp(b.email, b.purpose, clientMeta(req));
    return reply.code(204).send();
  });

  app.post('/api/v1/auth/signup', async (req) => {
    const b = parseBody(
      z.object({
        email: z.string(),
        password: z.string(),
        otp: z.string(),
        first_name: z.string().max(80),
        last_name: z.string().max(80).default(''),
        phone: z.string().max(20).optional(),
        referral_code: z.string().max(40).optional(),
        gender: z.enum(['male', 'female', 'other']).optional(),
      }),
      req.body,
    );
    await deps.auth.verifyOtp(b.email, b.otp, 'signup', clientMeta(req));
    return deps.auth.signUp(
      {
        email: b.email,
        password: b.password,
        data: { first_name: b.first_name, last_name: b.last_name, phone: b.phone ?? null, referral_code: b.referral_code ?? '', gender: b.gender ?? null },
      },
      clientMeta(req),
    );
  });

  app.post('/api/v1/auth/token', async (req) => {
    const b = parseBody(
      z.discriminatedUnion('grant_type', [
        z.object({ grant_type: z.literal('password'), email: z.string(), password: z.string() }),
        z.object({ grant_type: z.literal('refresh_token'), refresh_token: z.string() }),
      ]),
      req.body,
    );
    return b.grant_type === 'password'
      ? deps.auth.signInWithPassword(b.email, b.password, clientMeta(req))
      : deps.auth.refreshSession(b.refresh_token, clientMeta(req));
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const auth = await userOf(deps, req);
    await deps.auth.signOut(auth.userId, auth.sessionId, 'local');
    return reply.code(204).send();
  });

  app.post('/api/v1/auth/password', async (req) => {
    const auth = await userOf(deps, req);
    const b = parseBody(z.object({ current_password: z.string(), new_password: z.string() }), req.body);
    const user = await deps.users.findById(auth.userId);
    if (!user || !(await deps.passwords.verify(user.encrypted_password, b.current_password))) {
      throw new AppError(400, 'invalid_credentials', 'Your current password is incorrect');
    }
    return deps.auth.updateUser(auth.userId, auth.sessionId, { password: b.new_password });
  });

  app.post('/api/v1/auth/password/reset', async (req) => {
    const b = parseBody(z.object({ email: z.string() }), req.body);
    await deps.auth.recover(b.email, clientMeta(req));
    return { sent: true };
  });

  // ── wallet and payments ────────────────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/wallet', async (req) => {
    const auth = await userOf(deps, req);
    const { profileId } = await auth.identity();
    if (!profileId) throw new AppError(404, 'profile_not_found', 'Profile not found');
    const paise = await deps.ledger.balance('user_wallet', profileId);
    return { id: profileId, wallet_balance: toRupeesNumber(paise), currency: 'INR' };
  });

  app.post('/api/v1/payments/orders', async (req) => {
    const auth = await userOf(deps, req);
    return deps.payments.createOrder(auth, await auth.identity(), (req.body ?? {}) as Record<string, unknown>);
  });

  app.post('/api/v1/payments/verify', async (req) => {
    const auth = await userOf(deps, req);
    return deps.payments.verify(auth, (req.body ?? {}) as Record<string, unknown>);
  });

  /** Scan & Pay: an atomic wallet debit with a daily cap, replacing the client-written wallet_transactions row. */
  app.post('/api/v1/wallet/pay', async (req) => {
    const auth = await userOf(deps, req);
    const b = parseBody(
      z.object({
        payee_id: z.string().min(1).max(120),
        payee_name: z.string().max(120).default(''),
        amount: z.union([z.number(), z.string()]),
        note: z.string().max(200).optional(),
        idempotency_key: z.string().min(8).max(100).optional(),
      }),
      req.body,
    );
    const { profileId } = await auth.identity();
    if (!profileId) throw new AppError(404, 'profile_not_found', 'Profile not found');
    const paise = positiveAmount(b.amount, { maxRupees: 50_000 });
    await deps.limiter.hit('wallet-pay', auth.userId, { limit: 20, windowSec: 3600 });
    const r = await deps.ledger.run('user_wallet', {
      accountId: profileId,
      deltaPaise: -paise,
      kind: 'service_payment',
      idempotencyKey: `pay:${auth.userId}:${b.idempotency_key ?? uuid()}`,
      createdBy: `user:${auth.userId}`,
      paymentMethod: 'wallet',
      description: `Scan & Pay · ${b.payee_name || b.payee_id}`,
      details: { channel: 'scan_pay', payee_id: b.payee_id, payee_name: b.payee_name, note: b.note ?? null },
    });
    return { id: r.historyRowId, wallet_balance: toRupeesNumber(r.balanceAfterPaise), duplicate: r.alreadyApplied };
  });
}
