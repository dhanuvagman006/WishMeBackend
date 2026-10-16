/**
 * Referral RPCs, with the response shapes of the production SQL functions (Supabase audit export, schema.sql):
 *  validate_referral_code   a JSON text scalar: the referrer's first name ('a WishMe member' when blank), or null
 *  get_my_referrals         one row per directly referred profile (profiles.referred_by = my profile id)
 *  get_my_referral_history  [{ id, commission_level, commission_amount, status, order_type, created_at, referred_name }]
 *
 * profiles.referred_by holds the referrer's profiles.id; production's sync_referral_from_metadata trigger sets it from
 * the referral_code given at sign-up.
 */
import type { CompatResult, RpcContext } from '../../compat/postgrest/policy.js';
import { AppError } from '../../lib/errors.js';

export async function validateReferralCode(c: RpcContext): Promise<CompatResult> {
  await c.deps.limiter.hit('referral-validate', c.ip, { limit: 30, windowSec: 600 }, 'Too many attempts. Please wait a few minutes.');
  const raw = c.args.p_code;
  const code = typeof raw === 'string' ? raw.replace(/\s/g, '').toUpperCase() : '';
  if (!/^[A-Z0-9]{4,20}$/.test(code)) return { status: 200, body: 'null' };
  const rows = await c.deps.db<{ name: string }[]>`
    select coalesce(nullif(btrim(first_name), ''), 'a WishMe member') as name
    from public.profiles where upper(referral_code) = ${code} limit 1`;
  return { status: 200, body: JSON.stringify(rows[0]?.name ?? null) };
}

function profileOf(c: RpcContext): string {
  if (!c.identity.profileId) throw new AppError(403, '42501', 'A profile is required');
  return c.identity.profileId;
}

export async function getMyReferrals(c: RpcContext): Promise<CompatResult> {
  const me = profileOf(c);
  // Production also returns each referred user's email; the app only counts the rows, so emails are not exposed here.
  const rows = await c.deps.db<{ body: string }[]>`
    select coalesce(json_agg(r order by r.created_at desc), '[]'::json)::text as body from (
      select p.id, p.first_name, p.last_name, p.created_at, p.plan::text as plan
      from public.profiles p where p.referred_by = ${me}
    ) r`;
  return { status: 200, body: rows[0]?.body ?? '[]' };
}

export async function getMyReferralHistory(c: RpcContext): Promise<CompatResult> {
  const me = profileOf(c);
  const rows = await c.deps.db<{ body: string }[]>`
    select coalesce(json_agg(r order by r.created_at desc), '[]'::json)::text as body from (
      select t.id, t.commission_level, t.commission_amount, coalesce(t.status, 'pending') as status, t.order_type, t.created_at,
             coalesce(
               nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(nullif(left(p.last_name, 1), '') || '.', '')), ''),
               'A WishMe member'
             ) as referred_name
      from public.referral_transactions t
      left join public.profiles p on p.id = t.referred_id
      where t.referrer_id = ${me}
      order by t.created_at desc
      limit 200
    ) r`;
  return { status: 200, body: rows[0]?.body ?? '[]' };
}
