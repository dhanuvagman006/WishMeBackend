/**
 * Server-side prices. Every charge reads its base price here (platform_settings, plans, celebrity prices) and applies
 * the caller's plan discount here, so the amount never comes from the client.
 */
import type { Db, Tx } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { fromRupees } from '../lib/money.js';

/**
 * Reads a platform setting. setting_value is jsonb in the app's usage and holds either a bare number/string or an
 * object such as { "amount": 499 } / { "price": 499 } / { "value": 499 }.
 */
export async function settingValue(q: Db | Tx, key: string): Promise<unknown> {
  const rows = await q<{ setting_value: unknown }[]>`select setting_value from public.platform_settings where setting_key = ${key} limit 1`;
  return rows[0]?.setting_value ?? null;
}

/** A price setting in paise; throws 503 when the setting is missing so nothing is ever sold for free by accident. */
export async function settingPricePaise(q: Db | Tx, key: string): Promise<number> {
  const v = await settingValue(q, key);
  const pick = (x: unknown): unknown =>
    x !== null && typeof x === 'object' ? ((x as Record<string, unknown>).amount ?? (x as Record<string, unknown>).price ?? (x as Record<string, unknown>).value) : x;
  const raw = pick(v);
  if (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) {
    const paise = fromRupees(raw as string | number);
    if (paise > 0) return paise;
  }
  throw new AppError(503, 'price_unavailable', `Pricing for ${key} is not configured`);
}

/** The caller's plan discount (0–90 %) from profiles.plan → plans.service_discount_percentage. */
export async function planDiscountPercent(q: Db | Tx, profileId: string): Promise<number> {
  const rows = await q<{ pct: string | null }[]>`
    select p.service_discount_percentage::text as pct
    from public.profiles pr join public.plans p on lower(p.name) = lower(coalesce(pr.plan, 'basic'))
    where pr.id = ${profileId} and p.is_active = true limit 1`;
  const pct = Number(rows[0]?.pct ?? 0);
  return Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 90) : 0;
}

/** Applies a percentage discount, rounding to whole rupees the way the app displays prices. */
export function discounted(paise: number, percent: number): number {
  if (percent <= 0) return paise;
  const rupees = Math.round((paise / 100) * (1 - percent / 100));
  return Math.max(rupees, 1) * 100;
}
