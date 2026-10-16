/** Lookups shared by the celebrities domain's handlers and payment purposes. */
import type { Db, Tx } from '../../lib/db.js';
import { sql, type Sql } from '../../lib/sql.js';

/**
 * A celebrity is in the public catalogue when is_active is true: the production RLS policy "Everyone can view active
 * celebrities" (audit). celebrities has no status column; screens narrow further with is_verified / consent_status.
 */
export function catalogueRow(col: (name: string) => Sql): Sql {
  return sql`${col('is_active')} is true`;
}

export interface CelebrityRow {
  id: string;
  name: string;
  profile_id: string | null;
  service_prices: Record<string, unknown> | null;
}

/** A celebrity that can be booked or subscribed to: active, and not one whose consent was rejected. */
export async function availableCelebrity(q: Db | Tx, id: string): Promise<CelebrityRow | null> {
  const rows = await q<CelebrityRow[]>`
    select c.id::text, c.name, c.profile_id::text, c.service_prices
    from public.celebrities c
    where c.id = ${id} and c.is_active is true and c.consent_status is distinct from 'rejected'`;
  return rows[0] ?? null;
}

/** An active, unexpired subscription of a user to a celebrity. */
export async function hasActiveSubscription(q: Db | Tx, profileId: string, celebrityId: string): Promise<boolean> {
  const rows = await q`
    select 1 from public.celebrity_favorites f
    where f.user_id = ${profileId} and f.celebrity_id = ${celebrityId} and f.status = 'active'
      and (f.subscription_expires_at is null or f.subscription_expires_at > now())
    limit 1`;
  return rows.length > 0;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
