/**
 * POST push_tokens (services/hub/notifications.ts registerPushToken): an upsert on the token with the owner taken from
 * the access token. The app sends `Prefer: resolution=merge-duplicates` without `on_conflict`, so the conflict target is
 * applied here.
 *
 * user_id is the AUTH user id (production: FK to auth.users, RLS auth.uid() = user_id): the reminder dispatcher and the
 * `push` job look tokens up by it. The unique key is token (audit schema).
 * A token that re-registers under another account moves to that account: only the device holding the token can
 * present it, and the previous account must stop receiving pushes on a device it no longer uses.
 */
import { z } from 'zod';
import type { CompatResult, CustomArgs } from '../../compat/postgrest/policy.js';
import { AppError } from '../../lib/errors.js';
import { represent } from './rows.js';

export const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

const Row = z.object({
  token: z.string().trim().regex(EXPO_TOKEN_RE, 'not an Expo push token'),
  // NOT NULL with a CHECK in production (audit schema).
  platform: z.enum(['ios', 'android', 'web']),
  last_seen_at: z.string().max(40).nullish(),
});

export async function upsertPushToken(a: CustomArgs): Promise<CompatResult> {
  if (a.auth.kind === 'anon' || !a.auth.userId) throw new AppError(401, '42501', 'permission denied: sign in required');
  const body = Array.isArray(a.body) && a.body.length === 1 ? a.body[0] : a.body;
  const r = Row.safeParse(body);
  if (!r.success) throw new AppError(400, '22023', `Invalid ${r.error.issues[0]?.path.join('.') || 'row'}`);
  await a.deps.limiter.hit('push-token', a.auth.userId, { limit: 20, windowSec: 3600 });
  // The server clock decides last_seen_at; the client's value is only a hint and is ignored.
  const rows = await a.deps.db<{ id: string }[]>`
    insert into public.push_tokens (user_id, token, platform, last_seen_at)
    values (${a.auth.userId}, ${r.data.token}, ${r.data.platform}, now())
    on conflict (token) do update
      set user_id = excluded.user_id, platform = excluded.platform, last_seen_at = now()
    returning id::text`;
  return represent(a, 'push_tokens', rows.map((x) => x.id));
}
