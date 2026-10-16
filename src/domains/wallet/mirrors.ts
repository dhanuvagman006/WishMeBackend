/**
 * Client "mirror" rows.
 *
 * Many app flows do the real work through one call (create a booking, generate a photo wish, verify a Razorpay
 * payment) and then write their own wallet_transactions / payment_transactions rows describing what happened. On this
 * server the real work already moved the money and wrote the history row, so those follow-up client inserts must not
 * move money again. They are answered with the server's row instead ("claimed").
 *
 * How a domain participates:
 *  1. When it charges, it calls ledger.apply(...) with `details.mirrorable = true` (use `markMirrorable(details)`).
 *  2. The wallet_transactions / payment_transactions custom insert handlers call `claimMirror` with what the client
 *     sent; a recent, unclaimed, same-user, same-amount server movement of a compatible kind is marked claimed for that
 *     table and returned. Each server movement can be claimed once per table.
 */
import type { Db, Tx } from '../../lib/db.js';

export const MIRROR_WINDOW_SEC = 600;

export function markMirrorable(details: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...details, mirrorable: true };
}

export interface ClaimedMovement {
  ledgerId: string;
  historyRowId: string | null;
  kind: string;
  amountPaise: number;
  referenceType: string | null;
  referenceId: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Finds and claims the most recent matching server movement.
 *  - accountId: profiles.id of the caller (from the token, never from the body)
 *  - absAmountPaise: |amount| the client wrote
 *  - kinds: transaction types that count as the same movement (e.g. ['booking','withdrawal'])
 *  - table: which client table is mirroring ('wallet_transactions' | 'payment_transactions')
 *  - referenceId: when the client sent one (order id, booking id), it must match
 */
export async function claimMirror(
  q: Db | Tx,
  input: { accountId: string; absAmountPaise: number; kinds: readonly string[]; table: string; referenceId?: string | null; razorpayPaymentId?: string | null },
): Promise<ClaimedMovement | null> {
  const claimKey = `claimed_${input.table}`;
  const rows = await q<
    { id: string; public_row_id: string | null; kind: string; amount_paise: string; reference_type: string | null; reference_id: string | null; metadata: Record<string, unknown> }[]
  >`
    update wishme.ledger_entries set metadata = metadata || jsonb_build_object(${claimKey}::text, true)
    where id = (
      select id from wishme.ledger_entries
      where account_kind = 'user_wallet'
        and account_id = ${input.accountId}
        and kind = any(${input.kinds as string[]}::text[])
        and (abs(amount_paise) = ${input.absAmountPaise} or (amount_paise = 0 and (metadata ->> 'display_paise')::bigint = ${input.absAmountPaise}))
        and created_at > now() - make_interval(secs => ${MIRROR_WINDOW_SEC})
        and coalesce((metadata ->> 'mirrorable')::boolean, false)
        and not coalesce((metadata ->> ${claimKey})::boolean, false)
        and (${input.referenceId ?? null}::text is null or reference_id = ${input.referenceId ?? null}::text
             or metadata ->> 'order_id' = ${input.referenceId ?? null}::text)
        and (${input.razorpayPaymentId ?? null}::text is null or reference_id = ${input.razorpayPaymentId ?? null}::text)
      order by created_at desc
      limit 1
      for update skip locked)
    returning id::text, public_row_id, kind, amount_paise::text, reference_type, reference_id, metadata`;
  const r = rows[0];
  if (!r) return null;
  return {
    ledgerId: r.id,
    historyRowId: r.public_row_id,
    kind: r.kind,
    amountPaise: Number(r.amount_paise),
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    metadata: r.metadata,
  };
}
