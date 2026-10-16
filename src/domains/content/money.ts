/**
 * Prices and wallet movements for paid content. Prices come from platform_settings / celebrity service_prices plus the
 * caller's plan discount (the same rounding the app shows, see pricing.ts); the client's amounts are never used.
 *
 * Every paid generation is debited BEFORE the vendor is called, with an idempotency key derived from the row id
 * (`content:<table>:<id>:debit`), and refunded through the ledger (kind 'refund', key `...:refund`) when the
 * generation fails, so a retry, a crash or a sweeper can always find out what was charged and undo it exactly once.
 */
import type { Deps } from '../../deps.js';
import type { Queryable, Tx } from '../../lib/db.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { randomDigits } from '../../lib/crypto.js';
import { fromRupees } from '../../lib/money.js';
import { discounted, planDiscountPercent, settingPricePaise } from '../pricing.js';
import type { MovementResult } from '../wallet/ledger.js';
import { markMirrorable } from '../wallet/mirrors.js';

/** A payment id in the server's format (same as Payments: WM + yymmdd + 8 digits). */
export function newWishmePaymentId(): string {
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `WM${ymd}${randomDigits(8)}`;
}

/**
 * Money columns of the content tables are INTEGER rupees in production, so every price is a whole number of rupees
 * (the app shows Math.round(base * (1 - discount/100)), which is what pricing.discounted computes).
 */
export function wholeRupees(paise: number): number {
  return Math.max(Math.round(paise / 100), 1) * 100;
}

/** Rupees as a JS number for INTEGER money columns and JSON responses. */
export const rupees = (paise: number): number => Math.round(paise / 100);

/** The caller's plan discount (0-90 %), the shared rule in pricing.planDiscountPercent. */
export function planDiscount(q: Queryable, profileId: string): Promise<number> {
  return planDiscountPercent(q, profileId);
}

/** A price with the caller's plan discount applied (paise, whole rupees). */
export async function priceForUser(q: Queryable, profileId: string, basePaise: number): Promise<number> {
  return wholeRupees(discounted(basePaise, await planDiscount(q, profileId)));
}

/** platform_settings price with the caller's plan discount, in paise (whole rupees). */
export async function settingPriceForUser(q: Queryable, profileId: string, key: string): Promise<number> {
  return priceForUser(q, profileId, await settingPricePaise(q, key));
}

export interface CelebrityPricing {
  id: string;
  name: string;
  category: string | null;
  imageUrl: string | null;
  servicePrices: Record<string, unknown>;
  heygenAvatarId: string | null;
  heygenVoiceId: string | null;
}

/** Loads a celebrity that can take orders (active, consent not rejected). */
export async function orderableCelebrity(q: Queryable, celebrityId: string): Promise<CelebrityPricing> {
  // The production RPCs require is_active = true; consent_status = 'rejected' is excluded as well because the app
  // never offers those celebrities (the list filters them out), so an order for one can only be forged.
  const rows = await q<{ id: string; name: string; category: string | null; image_url: string | null; service_prices: Record<string, unknown> | null; heygen_avatar_id: string | null; heygen_voice_id: string | null }[]>`
    select id::text, name, category, image_url, service_prices, heygen_avatar_id, heygen_voice_id from public.celebrities
    where id = ${celebrityId}::uuid and is_active = true and coalesce(consent_status, '') <> 'rejected'`;
  const c = rows[0];
  if (!c) throw badRequest('Celebrity not available', 'celebrity_unavailable');
  return {
    id: c.id,
    name: c.name,
    category: c.category,
    imageUrl: c.image_url,
    servicePrices: c.service_prices ?? {},
    heygenAvatarId: c.heygen_avatar_id,
    heygenVoiceId: c.heygen_voice_id,
  };
}

/** A positive rupee price from celebrities.service_prices[key] in paise, or 0 when absent / not a positive number. */
export function celebrityPricePaise(c: CelebrityPricing, key: string): number {
  const v = c.servicePrices[key];
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return 0;
  try {
    const p = fromRupees(v as number | string);
    return p > 0 ? p : 0;
  } catch {
    return 0;
  }
}

export interface ChargeSpec {
  profileId: string;
  userId: string;
  /** The app's transaction_type for this service (wallet history labels it). */
  kind: string;
  /** payment_transactions.service_type the app sends for this service (mirror claims match on it). */
  serviceType: string;
  pricePaise: number;
  /** Table the charge is for; with the row id it forms the idempotency key and the ledger reference. */
  table: string;
  rowId: string;
  description: string;
  wishmePaymentId?: string;
  /** Allow the app's follow-up wallet_transactions / payment_transactions insert to be claimed as this movement. */
  mirrorable?: boolean;
  /** Extra keys for the history row's transaction_details (the production functions' own keys, e.g. generation_id). */
  extraDetails?: Record<string, unknown>;
}

export const debitKey = (table: string, rowId: string) => `content:${table}:${rowId}:debit`;
export const refundKey = (table: string, rowId: string) => `content:${table}:${rowId}:refund`;

/** Debits the wallet inside the caller's transaction (throws 400 "Insufficient wallet balance" when short). */
export async function chargeWallet(tx: Tx, deps: Deps, s: ChargeSpec): Promise<MovementResult> {
  if (!Number.isSafeInteger(s.pricePaise) || s.pricePaise <= 0) throw new AppError(503, 'price_unavailable', 'Pricing is not configured');
  const details = {
    ...(s.extraDetails ?? {}),
    service_type: s.serviceType,
    order_id: s.rowId,
    ...(s.wishmePaymentId ? { wishme_payment_id: s.wishmePaymentId } : {}),
  };
  return deps.ledger.apply(tx, 'user_wallet', {
    accountId: s.profileId,
    deltaPaise: -s.pricePaise,
    kind: s.kind,
    idempotencyKey: debitKey(s.table, s.rowId),
    createdBy: `user:${s.userId}`,
    description: s.description,
    paymentMethod: 'wallet',
    details: s.mirrorable === false ? details : markMirrorable(details),
    reference: { type: s.table, id: s.rowId },
  });
}

/**
 * Refunds whatever was debited for this row, once. Safe to call when nothing was charged (returns null).
 * Runs inside the caller's transaction so it commits together with the row's 'failed' status.
 */
export async function refundRow(tx: Tx, deps: Deps, table: string, rowId: string, reason: string): Promise<MovementResult | null> {
  const charged = await tx<{ account_id: string; amount_paise: string; metadata: Record<string, unknown> }[]>`
    select account_id::text, amount_paise::text, metadata from wishme.ledger_entries
    where idempotency_key = ${debitKey(table, rowId)} and account_kind = 'user_wallet'`;
  const c = charged[0];
  if (!c || Number(c.amount_paise) >= 0) return null;
  return deps.ledger.apply(tx, 'user_wallet', {
    accountId: c.account_id,
    deltaPaise: -Number(c.amount_paise),
    kind: 'refund',
    idempotencyKey: refundKey(table, rowId),
    createdBy: 'system:content',
    description: 'Refund: generation failed',
    paymentMethod: 'wallet',
    details: { service_type: c.metadata.service_type ?? null, order_id: rowId, reason: reason.slice(0, 200) },
    reference: { type: table, id: rowId },
  });
}
