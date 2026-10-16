/**
 * /api/v1/admin — operations that today happen in the Supabase dashboard and must keep working after cutover:
 * payouts, celebrity applications, wallet adjustments and ledger checks. Admins are listed in ADMIN_USER_IDS.
 * Every action is written to wishme.audit_log with the admin's id, IP and request id.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdmin, type AuthContext } from '../../auth/context.js';
import { parseBody } from '../../compat/functions/registry.js';
import type { Deps } from '../../deps.js';
import type { Tx } from '../../lib/db.js';
import { AppError, badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { fromRupees, toRupeesNumber } from '../../lib/money.js';
import { uuid } from '../../lib/crypto.js';

async function admin(deps: Deps, req: FastifyRequest): Promise<AuthContext & { userId: string }> {
  const h = req.headers.authorization;
  const token = typeof h === 'string' ? /^Bearer\s+(.+)$/i.exec(h)?.[1] : undefined;
  if (!token) throw unauthorized();
  const auth = await deps.resolver.resolve(token);
  requireAdmin(auth);
  return auth as AuthContext & { userId: string };
}

async function audit(q: Tx | Deps['db'], who: AuthContext, req: FastifyRequest, action: string, subject: string, details: Record<string, unknown>) {
  await q`
    insert into wishme.audit_log (actor, action, subject, ip, request_id, details)
    values (${`admin:${who.userId}`}, ${action}, ${subject}, ${req.ip}, ${String(req.id)}, ${q.json(details as never)})`;
}

/** Writes only columns that exist on the table (the Supabase schema is introspected, not assumed). */
function existing(deps: Deps, table: string, row: Record<string, unknown>): Record<string, unknown> {
  const info = deps.schema.table(table);
  if (!info) throw new AppError(503, 'table_missing', `${table} does not exist`);
  return Object.fromEntries(Object.entries(row).filter(([k]) => info.columns.has(k)));
}

export function registerAdmin(app: FastifyInstance, deps: Deps): void {
  // ── payouts ────────────────────────────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/admin/payouts', async (req) => {
    await admin(deps, req);
    const status = (req.query as { status?: string }).status ?? 'pending';
    const rows = await deps.db`
      select * from public.payout_requests where status = ${status}
      order by ${deps.db(deps.schema.table('payout_requests')?.columns.has('requested_at') ? 'requested_at' : 'id')} asc limit 200`;
    return { items: rows };
  });

  app.post('/api/v1/admin/payouts/:id/approve', async (req) => {
    const who = await admin(deps, req);
    const { id } = req.params as { id: string };
    const b = parseBody(z.object({ reference: z.string().max(120).optional(), note: z.string().max(500).optional() }), req.body);
    return deps.db.begin(async (tx) => {
      const rows = await tx<{ id: string; status: string }[]>`select id, status from public.payout_requests where id = ${id} for update`;
      if (!rows[0]) throw notFound('Payout request not found');
      if (rows[0].status !== 'pending') throw new AppError(409, 'not_pending', `Payout is ${rows[0].status}`);
      const patch = existing(deps, 'payout_requests', { status: 'approved', processed_at: new Date(), admin_notes: b.note ?? null, transaction_reference: b.reference ?? null });
      await tx`update public.payout_requests set ${tx(patch)} where id = ${id}`;
      await audit(tx, who, req, 'payout.approve', id, { reference: b.reference ?? null });
      return { id, status: 'approved' };
    });
  });

  app.post('/api/v1/admin/payouts/:id/reject', async (req) => {
    const who = await admin(deps, req);
    const { id } = req.params as { id: string };
    const b = parseBody(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return deps.db.begin(async (tx) => {
      const rows = await tx<{ id: string; status: string; celebrity_id: string; requested_amount: string }[]>`
        select id, status, celebrity_id, requested_amount::text from public.payout_requests where id = ${id} for update`;
      const p = rows[0];
      if (!p) throw notFound('Payout request not found');
      if (p.status !== 'pending') throw new AppError(409, 'not_pending', `Payout is ${p.status}`);
      // The request held the money (ledger kind payout_hold); rejecting releases it, exactly once.
      await deps.ledger.apply(tx, 'celebrity_earnings', {
        accountId: p.celebrity_id,
        deltaPaise: fromRupees(p.requested_amount),
        kind: 'payout_release',
        idempotencyKey: `payout:${id}:release`,
        createdBy: `admin:${who.userId}`,
        skipHistoryRow: true,
        reference: { type: 'payout_request', id },
        details: { reason: b.reason },
      });
      const patch = existing(deps, 'payout_requests', { status: 'rejected', processed_at: new Date(), admin_notes: b.reason });
      await tx`update public.payout_requests set ${tx(patch)} where id = ${id}`;
      await audit(tx, who, req, 'payout.reject', id, { reason: b.reason });
      return { id, status: 'rejected' };
    });
  });

  // ── celebrity applications ─────────────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/admin/celebrity-applications', async (req) => {
    await admin(deps, req);
    const status = (req.query as { status?: string }).status ?? 'pending';
    return { items: await deps.db`select * from public.celebrity_applications where status = ${status} order by created_at asc limit 200` };
  });

  app.post('/api/v1/admin/celebrity-applications/:id/decide', async (req) => {
    const who = await admin(deps, req);
    const { id } = req.params as { id: string };
    const b = parseBody(z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(500).optional() }), req.body);
    return deps.db.begin(async (tx) => {
      const rows = await tx<Record<string, unknown>[]>`select * from public.celebrity_applications where id = ${id} for update`;
      const a = rows[0];
      if (!a) throw notFound('Application not found');
      if (a.status !== 'pending') throw new AppError(409, 'not_pending', `Application is ${String(a.status)}`);
      let celebrityId: string | null = null;
      if (b.decision === 'approved') {
        // ASSUMPTION: approval creates the celebrities row for the applicant's profile (found by the application's
        // email), unless one exists. The audit dump will show whether a Supabase trigger did this instead.
        const prof = await tx<{ id: string }[]>`select id from public.profiles where lower(email) = lower(${String(a.email ?? '')}) limit 1`;
        if (!prof[0]) throw badRequest('The applicant has no account yet: they must sign up with the same email first');
        const exist = await tx<{ id: string }[]>`select id from public.celebrities where profile_id = ${prof[0].id} limit 1`;
        if (exist[0]) celebrityId = exist[0].id;
        else {
          const row = existing(deps, 'celebrities', {
            profile_id: prof[0].id,
            name: a.stage_name ?? `${String(a.first_name ?? '')} ${String(a.last_name ?? '')}`.trim(),
            category: a.category ?? null,
            bio: a.bio ?? null,
            social_media: a.social_media ?? null,
            status: 'approved',
            consent_status: 'pending',
          });
          const created = await tx<{ id: string }[]>`insert into public.celebrities ${tx(row)} returning id`;
          celebrityId = created[0]!.id;
          await tx`update public.profiles set role = 'celebrity' where id = ${prof[0].id}`;
        }
      }
      const patch = existing(deps, 'celebrity_applications', { status: b.decision, reviewed_at: new Date(), admin_notes: b.note ?? null });
      await tx`update public.celebrity_applications set ${tx(patch)} where id = ${id}`;
      await audit(tx, who, req, `celebrity_application.${b.decision}`, id, { celebrityId });
      return { id, status: b.decision, celebrity_id: celebrityId };
    });
  });

  // ── wallet adjustments ─────────────────────────────────────────────────────────────────────────────────────
  app.post('/api/v1/admin/wallet/adjust', async (req) => {
    const who = await admin(deps, req);
    const b = parseBody(
      z.object({
        profile_id: z.string().uuid(),
        amount: z.union([z.number(), z.string()]),
        reason: z.string().min(5).max(500),
        idempotency_key: z.string().min(8).max(100).optional(),
      }),
      req.body,
    );
    const paise = fromRupees(b.amount);
    if (paise === 0 || Math.abs(paise) > 10_000_000) throw badRequest('Amount must be non-zero and at most ₹1,00,000');
    return deps.db.begin(async (tx) => {
      const r = await deps.ledger.apply(tx, 'user_wallet', {
        accountId: b.profile_id,
        deltaPaise: paise,
        kind: paise > 0 ? 'admin_credit' : 'debit',
        idempotencyKey: `admin:${b.idempotency_key ?? uuid()}`,
        createdBy: `admin:${who.userId}`,
        paymentMethod: 'admin',
        description: b.reason,
        details: { reason: b.reason },
      });
      await audit(tx, who, req, 'wallet.adjust', b.profile_id, { amount_paise: paise, reason: b.reason, ledger: r.ledgerId });
      return { wallet_balance: toRupeesNumber(r.balanceAfterPaise), ledger_id: r.ledgerId, duplicate: r.alreadyApplied };
    });
  });

  // ── checks ─────────────────────────────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/admin/ledger/invariants', async (req) => {
    await admin(deps, req);
    const mismatches = await deps.ledger.verifyInvariants();
    return { ok: mismatches.length === 0, mismatches };
  });

  app.get('/api/v1/admin/audit', async (req) => {
    await admin(deps, req);
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 100) || 100, 500);
    return { items: await deps.db`select * from wishme.audit_log order by at desc limit ${limit}` };
  });
}
