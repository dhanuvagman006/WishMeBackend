/**
 * Travel bookings this server paid for: one row per flight or hotel attempt, created in the same transaction as the
 * wallet debit, and moved through its states only with guarded updates.
 *
 *   charged ──(LCC Ticket ok / hotel Book ok)──────────────► confirmed
 *   charged ──(non-LCC Book ok)──► booked ──► ticketing ──► confirmed
 *   any of charged/booked/ticketing ──(TBO said no)────────► refunded   (wallet refunded, PNR released)
 *   any of charged/ticketing ──(outcome unknown)───────────► needs_review (money kept; support reconciles)
 *
 * Table: wishme.travel_bookings (migrations/0004_travel_bookings.sql).
 *
 * `summary` holds non-personal facts only (route, airline, fare, ticket numbers); passenger details stay at TBO.
 */
import { randomUUID } from 'node:crypto';
import type { Deps } from '../../deps.js';
import type { Db, Tx } from '../../lib/db.js';

export type TravelKind = 'flight' | 'hotel';
export type TravelStatus = 'charged' | 'booked' | 'ticketing' | 'confirmed' | 'refunded' | 'needs_review';

/**
 * Ledger kinds for travel. The wallet_transactions CHECK constraint has no travel type, so the ledger records the
 * history row as 'debit' (refunds as 'admin_credit') with this kind in transaction_details.kind; the description
 * ("Flight DEL-BOM 6E2041") is what the app's history shows.
 */
export const TRAVEL_TX_KIND: Record<TravelKind, string> = { flight: 'flight_booking', hotel: 'hotel_booking' };

export interface TravelBooking {
  id: string;
  kind: TravelKind;
  user_id: string;
  profile_id: string;
  status: TravelStatus;
  amount_paise: string;
  trace_id: string | null;
  result_index: string | null;
  is_lcc: boolean | null;
  pnr: string | null;
  tbo_booking_id: string | null;
  confirmation_no: string | null;
  summary: Record<string, unknown>;
  created_at: Date;
}

export interface Payer {
  userId: string;
  profileId: string;
}

/** Debits the wallet and records the attempt atomically. Throws InsufficientFunds (400) when the balance is short. */
export async function chargeBooking(
  deps: Deps,
  payer: Payer,
  input: {
    kind: TravelKind;
    amountPaise: number;
    description: string;
    traceId?: string | null;
    resultIndex?: string | null;
    isLcc?: boolean | null;
    summary: Record<string, unknown>;
  },
): Promise<{ id: string; ledgerId: string }> {
  const id = randomUUID();
  return (await deps.db.begin(async (tx) => {
    const m = await deps.ledger.apply(tx, 'user_wallet', {
      accountId: payer.profileId,
      deltaPaise: -input.amountPaise,
      kind: TRAVEL_TX_KIND[input.kind],
      idempotencyKey: `travel:${id}:debit`,
      createdBy: payer.userId,
      description: input.description,
      paymentMethod: 'wallet',
      details: { service_type: TRAVEL_TX_KIND[input.kind], order_id: id, travel_booking_id: id, trace_id: input.traceId ?? null },
      reference: { type: 'travel_booking', id },
    });
    await tx`
      insert into wishme.travel_bookings
        (id, kind, user_id, profile_id, status, amount_paise, ledger_id, trace_id, result_index, is_lcc, summary)
      values (${id}, ${input.kind}, ${payer.userId}, ${payer.profileId}, 'charged', ${input.amountPaise}, ${m.ledgerId},
              ${input.traceId ?? null}, ${input.resultIndex ?? null}, ${input.isLcc ?? null}, ${JSON.stringify(input.summary)}::text::jsonb)`;
    return { id, ledgerId: m.ledgerId };
  })) as { id: string; ledgerId: string };
}

/** Moves a booking from one of `from` to `to`, setting extra columns; false if it was not in `from`. */
export async function transition(
  q: Db | Tx,
  id: string,
  from: TravelStatus[],
  to: TravelStatus,
  set: { pnr?: string | null; tboBookingId?: string | null; confirmationNo?: string | null; summary?: Record<string, unknown>; error?: string | null } = {},
): Promise<boolean> {
  const res = await q`
    update wishme.travel_bookings set
      status = ${to},
      pnr = coalesce(${set.pnr ?? null}, pnr),
      tbo_booking_id = coalesce(${set.tboBookingId ?? null}, tbo_booking_id),
      confirmation_no = coalesce(${set.confirmationNo ?? null}, confirmation_no),
      summary = summary || ${JSON.stringify(set.summary ?? {})}::text::jsonb,
      error = coalesce(${set.error ?? null}, error),
      updated_at = now()
    where id = ${id} and status = any(${from}::text[])`;
  return res.count > 0;
}

/**
 * Refunds a failed booking once: the status moves to 'refunded' and the ledger credit uses a deterministic key, so
 * concurrent failure paths (request and sweep) credit exactly once.
 */
export async function refundBooking(deps: Deps, id: string, from: TravelStatus[], reason: string): Promise<boolean> {
  return (await deps.db.begin(async (tx) => {
    const rows = await tx<{ profile_id: string; kind: TravelKind; amount_paise: string }[]>`
      update wishme.travel_bookings set status = 'refunded', error = ${reason.slice(0, 300)}, updated_at = now()
      where id = ${id} and status = any(${from}::text[])
      returning profile_id::text, kind, amount_paise::text`;
    const b = rows[0];
    if (!b) return false;
    await deps.ledger.apply(tx, 'user_wallet', {
      accountId: b.profile_id,
      deltaPaise: Number(b.amount_paise),
      kind: 'refund',
      idempotencyKey: `travel:${id}:refund`,
      createdBy: 'system',
      description: b.kind === 'flight' ? 'Refund: flight booking' : 'Refund: hotel booking',
      // wallet_transactions.payment_method has a CHECK constraint without 'system'.
      paymentMethod: 'wallet',
      details: { service_type: TRAVEL_TX_KIND[b.kind], order_id: id, travel_booking_id: id, reason: reason.slice(0, 200) },
      reference: { type: 'travel_booking', id },
    });
    return true;
  })) as boolean;
}

export async function findOwnedBooking(deps: Deps, profileId: string, kind: TravelKind, tboBookingId: string): Promise<TravelBooking | null> {
  const rows = await deps.db<TravelBooking[]>`
    select id::text, kind, user_id::text, profile_id::text, status, amount_paise::text, trace_id, result_index, is_lcc, pnr,
           tbo_booking_id, confirmation_no, summary, created_at
    from wishme.travel_bookings
    where profile_id = ${profileId} and kind = ${kind} and tbo_booking_id = ${tboBookingId}
    limit 1`;
  return rows[0] ?? null;
}
