/**
 * Which B2 object keys a caller may get a signed URL for: keys under their own audio prefix, or keys stored on a row
 * they own. The rows are the ones the app resolves through b2-get-signed-url (services/library.ts,
 * components/bookings/CelebCard.tsx and WishFriendCard.tsx, components/ugc/UgcHistory.tsx). Each source is checked
 * only when its table and columns exist; table and column names are constants, never request input.
 */
import type { Identity } from '../../auth/context.js';
import type { Deps } from '../../deps.js';
import { audioPrefix } from './storage.js';

interface KeySource {
  table: string;
  keyColumn: string;
  ownerColumn: string;
  /** Which identity value owns the row. */
  owner: 'profile' | 'auth_user' | 'celebrity';
}

const SOURCES: KeySource[] = [
  { table: 'library_items', keyColumn: 'file_key', ownerColumn: 'user_id', owner: 'profile' },
  { table: 'wish_friend_orders', keyColumn: 'video_file_key', ownerColumn: 'user_id', owner: 'profile' },
  // ugc_ads.user_id is the auth uid (inventory, UgcHistory.tsx:173).
  { table: 'ugc_ads', keyColumn: 'video_file_key', ownerColumn: 'user_id', owner: 'auth_user' },
  { table: 'bookings', keyColumn: 'video_file_key', ownerColumn: 'user_id', owner: 'profile' },
  // The celebrity who delivered a booking video may watch it too.
  { table: 'bookings', keyColumn: 'video_file_key', ownerColumn: 'celebrity_id', owner: 'celebrity' },
  { table: 'image_promotions', keyColumn: 'video_file_key', ownerColumn: 'user_id', owner: 'profile' },
  { table: 'music_generations', keyColumn: 'file_key', ownerColumn: 'user_id', owner: 'profile' },
];

/** Basic shape check before any lookup: bounded, relative, no traversal or control characters. */
export function plausibleKey(key: string): boolean {
  return key.length > 0 && key.length <= 512 && !key.startsWith('/') && !key.includes('..') && !/[\u0000-\u001f\u007f\\]/.test(key);
}

export async function callerOwnsKey(deps: Deps, userId: string, identity: Identity, key: string): Promise<boolean> {
  if (!plausibleKey(key)) return false;
  if (identity.profileId && key.startsWith(audioPrefix(identity.profileId))) return true;

  const checks: Array<{ table: string; keyColumn: string; ownerColumn: string; owners: string[] }> = [];
  for (const s of SOURCES) {
    const info = deps.schema.table(s.table);
    if (!info?.columns.has(s.keyColumn) || !info.columns.has(s.ownerColumn)) continue;
    const owners = s.owner === 'profile' ? (identity.profileId ? [identity.profileId] : []) : s.owner === 'auth_user' ? [userId] : identity.celebrityIds;
    if (owners.length) checks.push({ table: s.table, keyColumn: s.keyColumn, ownerColumn: s.ownerColumn, owners });
  }
  if (checks.length === 0) return false;
  const text = checks
    .map((c, i) => `select 1 from public.${c.table} where "${c.keyColumn}" = $1 and "${c.ownerColumn}"::text = any($${i + 2}::text[])`)
    .join(' union all ');
  const rows = await deps.db.unsafe(`select exists(${text}) as ok`, [key, ...checks.map((c) => c.owners)] as never[]);
  return (rows[0] as { ok?: boolean } | undefined)?.ok === true;
}
