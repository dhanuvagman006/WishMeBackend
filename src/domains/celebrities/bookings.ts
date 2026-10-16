/**
 * Celebrity bookings (video wish, UGC ad, video promotion) paid from the wallet.
 *
 * The app's wizard (app/booking/[id].tsx) used to POST the booking, then write its own wallet_transactions
 * withdrawal and payment_transactions rows, computing the price on the phone. Here the POST /rest/v1/bookings is the
 * whole purchase: the server prices the service, checks the subscription the wish service requires, and in one
 * transaction creates the booking and debits the wallet through the ledger. The app's follow-up money rows are then
 * answered as mirrors of that debit (wallet_transactions / payment_transactions handlers, accounts domain).
 *
 * Production triggers on bookings stay in charge of what they already do and are not repeated here
 * (audit, 16 Oct 2026): booking_commission_trigger fills celebrity_commission / platform_fee / commission_percentage
 * (celebrities.commission_percentage is the celebrity's share, default 70, minus TDS) and credits the celebrity's
 * earnings when a booking becomes confirmed or completed; the referral triggers pay referrers at the same moments.
 *
 * Celebrities accept, decline and complete their own bookings; a declined paid booking is refunded to the user's
 * wallet, once.
 */
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { filtersSql } from '../../compat/postgrest/compiler.js';
import { parseRead, pgrstError } from '../../compat/postgrest/parser.js';
import type { CompatResult, CustomArgs } from '../../compat/postgrest/policy.js';
import { run, type Tx } from '../../lib/db.js';
import { AppError, badRequest, forbidden } from '../../lib/errors.js';
import { fromRupees } from '../../lib/money.js';
import { sql } from '../../lib/sql.js';
import { markMirrorable } from '../wallet/mirrors.js';
import { asCaller, hasColumn, insertRow, objectBody, represent, requireProfile, updateRow, uuidArray } from './compat.js';
import { availableCelebrity, hasActiveSubscription } from './shared.js';

export type BookingService = 'video_wish' | 'image_promotion' | 'video_promotion';

/**
 * Where each service's base price comes from, mirroring app/booking/[id].tsx (`??` semantics: a stored 0 means the
 * celebrity does not offer the service, and the server refuses it rather than selling it for free). The app's wish
 * fallback reads `price_per_wish`, a column production does not have, so its constant 1500 applies.
 */
const PRICE_SOURCE: Record<BookingService, { key: string; fallbackRupees: number; label: string }> = {
  video_wish: { key: 'general_wish', fallbackRupees: 1500, label: 'wish' },
  image_promotion: { key: 'ugc_ad', fallbackRupees: 25000, label: 'ad' },
  video_promotion: { key: 'video_promotion', fallbackRupees: 50000, label: 'video' },
};

/** The app adds a 10 % service fee, rounded to whole rupees (Math.round, half up). */
const SERVICE_FEE_PERCENT = 10;

export interface BookingQuote {
  baseRupees: number;
  discountRupees: number;
  feeRupees: number;
  finalRupees: number;
}

/** Server-side price of a booking in whole rupees (bookings' price columns are integer rupees in production). */
export function quoteBooking(service: BookingService, servicePrices: Record<string, unknown> | null): BookingQuote {
  const src = PRICE_SOURCE[service];
  const stored = (servicePrices ?? {})[src.key];
  const raw = stored === undefined || stored === null ? src.fallbackRupees : stored;
  let basePaise = NaN;
  try {
    if (typeof raw === 'number' || typeof raw === 'string') basePaise = fromRupees(raw);
  } catch {
    basePaise = NaN;
  }
  // Fractional rupees cannot be stored in the integer price columns, so such a price is not sellable either.
  if (!Number.isSafeInteger(basePaise) || basePaise <= 0 || basePaise % 100 !== 0) {
    throw badRequest('This service is not available for this celebrity', 'service_unavailable');
  }
  const baseRupees = basePaise / 100;
  // No plan discount: the app never applies one to bookings (discountPct stays 0), and charging a different amount
  // than the review screen shows would also break the mirror of the app's follow-up withdrawal row.
  const discountRupees = 0;
  const after = baseRupees - discountRupees;
  const feeRupees = Math.floor((after * SERVICE_FEE_PERCENT + 50) / 100);
  return { baseRupees, discountRupees, feeRupees, finalRupees: after + feeRupees };
}

const money = z.union([z.number(), z.string().max(20)]);

const CreateBooking = z
  .object({
    celebrity_id: z.string().uuid(),
    user_id: z.string().uuid().optional(),
    service_type: z.enum(['video_wish', 'image_promotion', 'video_promotion']),
    original_price: money.optional(),
    discount_amount: money.optional(),
    final_price: money.optional(),
    status: z.literal('pending').optional(),
    message: z.string().max(20_000).optional().nullable(),
    instructions: z.string().max(2_000).optional().nullable(),
    delivery_type: z.enum(['video', 'card', 'both']).optional().nullable(),
    generated_prompt: z.string().max(10_000).optional().nullable(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    if (issue.code === 'unrecognized_keys') {
      throw new AppError(403, '42501', `permission denied to write column "${issue.keys[0]}" of bookings`);
    }
    throw new AppError(400, '22023', `Invalid ${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return r.data;
}

/** POST /rest/v1/bookings: price, create and pay in one transaction. */
export async function createBooking(a: CustomArgs): Promise<CompatResult> {
  const { deps } = a;
  const profileId = requireProfile(a.auth, a.identity);
  if (Array.isArray(a.body)) throw pgrstError(400, 'PGRST102', 'Create one booking per request');
  const b = parse(CreateBooking, objectBody(a.body));
  if (b.user_id && b.user_id !== profileId) throw forbidden('You can only book for yourself', '42501');
  await deps.limiter.hit('booking-create', profileId, { limit: 10, windowSec: 600 }, 'Too many bookings in a short time. Please try again in a few minutes.');

  const celeb = await availableCelebrity(deps.db, b.celebrity_id);
  if (!celeb) throw badRequest('This celebrity is not available for booking', 'celebrity_unavailable');
  const quote = quoteBooking(b.service_type, celeb.service_prices);
  if (b.service_type === 'video_wish' && !(await hasActiveSubscription(deps.db, profileId, celeb.id))) {
    throw badRequest('You must subscribe to this celebrity to book', 'subscription_required');
  }
  if (b.final_price !== undefined) {
    let clientPaise: number | null = null;
    try {
      clientPaise = fromRupees(b.final_price);
    } catch {
      clientPaise = null;
    }
    // The user confirmed a price on the review screen; never charge a different one silently.
    if (clientPaise !== quote.finalRupees * 100) {
      throw new AppError(409, 'price_changed', 'The price for this booking has changed. Please go back and review it.', { price: quote.finalRupees });
    }
  }

  const label = PRICE_SOURCE[b.service_type].label;
  const bookingId = await deps.db.begin(async (tx) => {
    // Serialise this user's purchases (the ledger locks the same row), so a double tap cannot create two bookings.
    await tx`select id from public.profiles where id = ${profileId} for update`;
    const replay = await tx<{ id: string }[]>`
      select b.id::text from public.bookings b
      where b.user_id = ${profileId} and b.celebrity_id = ${celeb.id} and b.service_type::text = ${b.service_type}
        and b.message is not distinct from ${b.message ?? null} and b.created_at > now() - interval '2 minutes'
        and exists (select 1 from wishme.ledger_entries l where l.idempotency_key = 'booking:' || b.id::text || ':debit')
      order by b.created_at desc limit 1`;
    if (replay[0]) return replay[0].id;

    const id = await insertRow(deps, tx, 'bookings', {
      user_id: profileId,
      celebrity_id: celeb.id,
      service_type: b.service_type,
      original_price: quote.baseRupees,
      discount_amount: quote.discountRupees,
      final_price: quote.finalRupees,
      status: 'pending',
      message: b.message ?? null,
      instructions: b.instructions ?? null,
      delivery_type: b.delivery_type ?? 'video',
      generated_prompt: b.generated_prompt ?? null,
    });
    await deps.ledger.apply(tx, 'user_wallet', {
      accountId: profileId,
      deltaPaise: -quote.finalRupees * 100,
      // The app's follow-up row is a 'withdrawal' (booking/[id].tsx), so the server movement uses the same kind.
      kind: 'withdrawal',
      idempotencyKey: `booking:${id}:debit`,
      createdBy: `user:${a.auth.userId}`,
      paymentMethod: 'wallet',
      description: `Booking: ${celeb.name} - ${label}`,
      details: markMirrorable({ service_type: 'booking', order_id: id, booking_id: id, celebrity_id: celeb.id }),
      reference: { type: 'booking', id },
    });
    return id;
  });
  deps.log.info({ bookingId, profileId, service: b.service_type, rupees: quote.finalRupees }, 'booking created and paid');
  return represent(a, deps.db, [bookingId], 201);
}

/**
 * The dashboard sends `accepted` / `rejected`, which production's booking_status enum does not have (pending,
 * confirmed, in_progress, completed, cancelled, video_sent, failed), so those PATCHes always failed there. They are
 * translated to the enum's own words; the enum values themselves are accepted too.
 */
const STATUS_ALIAS: Record<string, string> = { accepted: 'confirmed', rejected: 'cancelled' };

/** Transitions a celebrity may make on its own bookings. */
const TRANSITIONS: Record<string, readonly string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed'],
  in_progress: ['completed'],
  video_sent: ['completed'],
};

const StatusPatch = z.object({ status: z.enum(['accepted', 'rejected', 'confirmed', 'cancelled', 'completed']) }).strict();
const PaymentIdPatch = z.object({ wishme_payment_id: z.string().regex(/^WM[A-Za-z0-9-]{4,40}$/) }).strict();

/** PATCH /rest/v1/bookings. */
export async function updateBookings(a: CustomArgs): Promise<CompatResult> {
  const body = objectBody(a.body);
  const filters = parseRead(a.params).where;
  if (filters.length === 0) throw pgrstError(400, '21000', 'UPDATE requires a WHERE clause');
  const keys = Object.keys(body);
  const info = a.deps.schema.table('bookings')!;

  if (keys.length === 1 && keys[0] === 'wishme_payment_id') {
    // The wallet flow stamps its display payment id on the booking it just paid for. Only the booking's own user,
    // only once, and only the id column: it is a reference, not a claim of payment.
    const p = parse(PaymentIdPatch, body);
    const profileId = requireProfile(a.auth, a.identity);
    if (!hasColumn(a.deps, 'bookings', 'wishme_payment_id')) return represent(a, a.deps.db, [], 200);
    const ids = await asCaller(a, async (tx) => {
      const rows = await run<{ id: string }>(tx, sql`
        update public.bookings as t0 set wishme_payment_id = ${p.wishme_payment_id}
        where t0.user_id = ${profileId}::uuid and t0.wishme_payment_id is null and ${filtersSql(info, null, 't0', filters)}
        returning t0.id::text as id`);
      return rows.map((r) => r.id);
    });
    return represent(a, a.deps.db, ids, 200);
  }

  if (!keys.includes('status')) {
    const k = keys[0] ?? 'body';
    throw new AppError(403, '42501', `permission denied to write column "${k}" of bookings`);
  }
  const requested = parse(StatusPatch, body).status;
  const target = STATUS_ALIAS[requested] ?? requested;
  const celebIds = a.identity.celebrityIds;
  if (a.auth.kind === 'anon' || celebIds.length === 0) return represent(a, a.deps.db, [], 200);

  // Runs as the connection role: production RLS has no celebrity UPDATE policy on bookings, the server checks
  // ownership and the transition itself.
  const ids = await a.deps.db.begin(async (tx) => {
    const rows = await run<{ id: string; status: string; celebrity_id: string }>(tx, sql`
      select t0.id::text as id, t0.status::text as status, t0.celebrity_id::text as celebrity_id from public.bookings as t0
      where t0.celebrity_id = any(${uuidArray(celebIds)}) and ${filtersSql(info, null, 't0', filters)}
      order by t0.id limit 51 for update`);
    if (rows.length > 50) throw badRequest('Update at most 50 bookings at a time');
    for (const r of rows) {
      if (r.status === target) continue;
      if (!TRANSITIONS[r.status]?.includes(target)) {
        throw new AppError(400, 'invalid_transition', `A ${r.status} booking cannot be marked ${requested}`);
      }
    }
    for (const r of rows) {
      if (r.status === target) continue;
      await updateRow(a.deps, tx, 'bookings', r.id, { status: target, ...(target === 'completed' ? { completed_at: new Date().toISOString() } : {}) });
      if (target === 'cancelled') await refundBooking(a.deps, tx, r.id, `celebrity:${r.celebrity_id}`);
    }
    return rows.map((r) => r.id);
  });
  return represent(a, a.deps.db, ids, 200);
}

/**
 * Refunds the wallet debit of a booking (idempotent: one refund per booking). Bookings paid before this server took
 * over have no ledger debit; those are logged for manual review instead of guessing an amount.
 */
export async function refundBooking(deps: Deps, tx: Tx, bookingId: string, actor: string): Promise<boolean> {
  const debit = await tx<{ account_id: string; amount_paise: string }[]>`
    select account_id::text, amount_paise::text from wishme.ledger_entries
    where idempotency_key = ${`booking:${bookingId}:debit`} and account_kind = 'user_wallet'`;
  if (!debit[0] || Number(debit[0].amount_paise) >= 0) {
    deps.log.warn({ bookingId }, 'declined booking has no server-side wallet debit; refund needs manual review');
    return false;
  }
  await deps.ledger.apply(tx, 'user_wallet', {
    accountId: debit[0].account_id,
    deltaPaise: -Number(debit[0].amount_paise),
    kind: 'refund',
    idempotencyKey: `booking:${bookingId}:refund`,
    createdBy: actor,
    paymentMethod: 'admin',
    description: 'Refund: booking declined by the celebrity',
    details: { service_type: 'booking', booking_id: bookingId, order_id: bookingId },
    reference: { type: 'booking', id: bookingId },
  });
  return true;
}
