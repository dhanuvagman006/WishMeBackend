/**
 * Table policies and RPCs for the accounts domain. See ../policy.ts for the model and CONTRIBUTING.md for the rules.
 * Owned tables are listed in docs/POLICY_OWNERSHIP.md; each table has exactly one policy in exactly one file.
 *
 * Money tables (wallet_transactions, payment_transactions, payout_requests) are written only through custom handlers in
 * src/domains/accounts/money.ts. Columns and constraints follow the production schema (Supabase audit export of 16 Oct
 * 2026); what the audit could not settle is marked ASSUMPTION.
 */
import { sql, or, type Sql } from '../../../lib/sql.js';
import { insertPaymentTransaction, insertPayoutRequest, insertWalletTransaction } from '../../../domains/accounts/money.js';
import { checkBankUpdate, insertBankDetails, readBankDetails } from '../../../domains/accounts/bank-details.js';
import { anonPhoneLookup, applicationStatusLookup, checkProfileUpdate, insertCelebrityApplication, planPatch } from '../../../domains/accounts/profiles.js';
import { upsertPushToken } from '../../../domains/accounts/push-tokens.js';
import { getMyReferralHistory, getMyReferrals, validateReferralCode } from '../../../domains/accounts/referrals.js';
import { definePolicy, defineRpc, type RowRule, type RpcDefinition, type TablePolicy } from '../policy.js';

// ── row rules ────────────────────────────────────────────────────────────────────────────────────────────────

/** column = the caller's profiles.id */
const ownProfile =
  (column: string): RowRule =>
  (c) =>
    c.identity.profileId ? sql`${c.col(column)} = ${c.identity.profileId}` : 'none';

/** column is one of the given ids (compared as text: some celebrity_id columns may not be uuid typed). */
function inIds(col: Sql, ids: readonly string[]): Sql {
  return sql`${col}::text = any(${`{${ids.join(',')}}`}::text[])`;
}

/** The caller's own profile row: by profile id, or by auth user id (login and the sign-up poll query by user_id). */
const profileOwner: RowRule = (c) => {
  const parts: Sql[] = [];
  if (c.identity.profileId) parts.push(sql`${c.col('id')} = ${c.identity.profileId}`);
  if (c.auth.kind !== 'anon' && c.auth.userId) parts.push(sql`${c.col('user_id')} = ${c.auth.userId}`);
  return parts.length ? or(parts) : 'none';
};

const signedIn: RowRule = (c) => (c.auth.kind === 'anon' ? 'none' : 'all');

/**
 * A celebrity sees name and email of their own followers (FollowersTab embeds profiles(first_name,last_name,email)).
 * Only compiled for callers who own a celebrity, so other reads never touch celebrity_favorites.
 */
const followerOfMyCelebrity: RowRule = (c) =>
  c.identity.celebrityIds.length === 0
    ? 'none'
    : sql`exists (select 1 from public.celebrity_favorites cf where cf.user_id = ${c.col('id')} and ${inIds(sql`cf.celebrity_id`, c.identity.celebrityIds)})`;

/** Platform settings the app reads (all display prices or limits). Everything else stays private. */
export const PUBLIC_SETTING_KEYS = [
  'conversation_message_limit',
  'greeting_card_price',
  'image_promotion_price',
  'photo_wish_price',
  'ugc_ads_price',
  'ugc_video_price',
] as const;

const PROFILE_PUBLIC_CARD = ['id', 'first_name', 'last_name', 'avatar_url'] as const;

// ── tables ───────────────────────────────────────────────────────────────────────────────────────────────────

export const tables: TablePolicy[] = [
  definePolicy({
    table: 'profiles',
    read: [
      { name: 'owner', rows: profileOwner, columns: '*' },
      // Names and avatars appear in embeds across the app (reviews, bookings, conversations, followers).
      { name: 'public-card', rows: signedIn, columns: PROFILE_PUBLIC_CARD },
      { name: 'follower-of-my-celebrity', rows: followerOfMyCelebrity, columns: [...PROFILE_PUBLIC_CARD, 'email'] },
    ],
    update: {
      rows: profileOwner,
      columns: [
        'first_name',
        'last_name',
        'phone',
        'avatar_url',
        'address',
        'bank_name',
        'bank_account_number',
        'bank_ifsc',
        'bank_account_holder_name',
        'aadhaar_number',
        'pan_number',
        'pan_document_url',
        'profile_completion_percentage',
      ],
      check: checkProfileUpdate,
    },
    custom: {
      // Anonymous "forgot password by phone"; every other read goes through the engine (anon sees nothing).
      read: anonPhoneLookup,
      // { plan } after Razorpay is confirmed, never written; every other PATCH goes through the update rule.
      update: planPatch,
    },
    realtime: {
      filterColumns: ['id'],
      authorize: (_auth, identity, column, value) => column === 'id' && !!identity.profileId && value === identity.profileId,
    },
  }),

  definePolicy({
    table: 'plans',
    read: [{ name: 'active', rows: (c) => sql`${c.col('is_active')} = true`, columns: '*' }],
    anonCacheSec: 60,
  }),

  definePolicy({
    table: 'platform_settings',
    read: [
      {
        name: 'public-keys',
        rows: (c) => sql`${c.col('setting_key')} = any(${`{${PUBLIC_SETTING_KEYS.join(',')}}`}::text[])`,
        columns: ['setting_key', 'setting_value'],
      },
    ],
    anonCacheSec: 60,
  }),

  definePolicy({
    table: 'wallet_transactions',
    read: [
      {
        name: 'own',
        // user_id references profiles.id in production, so TransactionsTab's retry with the auth user id (for "legacy
        // rows") can never match anything; only the profile id is needed.
        rows: ownProfile('user_id'),
        columns: '*',
      },
    ],
    custom: { insert: insertWalletTransaction },
  }),

  definePolicy({
    table: 'payment_transactions',
    read: [{ name: 'own', rows: ownProfile('user_id'), columns: '*' }],
    custom: { insert: insertPaymentTransaction },
  }),

  definePolicy({
    table: 'referral_transactions',
    read: [{ name: 'own', rows: ownProfile('referrer_id'), columns: '*' }],
  }),

  definePolicy({
    table: 'bank_details',
    read: [{ name: 'own', rows: ownProfile('user_id'), columns: '*' }],
    update: {
      rows: ownProfile('user_id'),
      columns: ['bank_name', 'account_number', 'ifsc_code', 'account_holder_name', 'account_type', 'is_default'],
      check: checkBankUpdate,
    },
    delete: { rows: ownProfile('user_id') },
    // Inserts accept WalletTab's bank_account_number spelling; star reads add it back (see bank-details.ts).
    custom: { insert: insertBankDetails, read: readBankDetails },
  }),

  definePolicy({
    table: 'payout_requests',
    read: [
      {
        name: 'my-celebrities',
        rows: (c) => (c.identity.celebrityIds.length ? inIds(c.col('celebrity_id'), c.identity.celebrityIds) : 'none'),
        columns: '*',
      },
    ],
    custom: { insert: insertPayoutRequest },
  }),

  definePolicy({
    table: 'celebrity_wallet_transactions',
    read: [
      {
        name: 'my-celebrities',
        // celebrity_id references celebrities.id (audit schema). commission.tsx filters it by the profile id, which
        // matches nothing in production either.
        rows: (c) => (c.identity.celebrityIds.length ? inIds(c.col('celebrity_id'), c.identity.celebrityIds) : 'none'),
        columns: '*',
      },
    ],
  }),

  definePolicy({
    table: 'push_tokens',
    read: [
      {
        name: 'own',
        rows: (c) => (c.auth.kind !== 'anon' && c.auth.userId ? sql`${c.col('user_id')} = ${c.auth.userId}` : 'none'),
        columns: ['id', 'token', 'platform', 'last_seen_at'],
      },
    ],
    custom: { insert: upsertPushToken },
  }),

  definePolicy({
    table: 'celebrity_applications',
    custom: { insert: insertCelebrityApplication, read: applicationStatusLookup },
  }),

  definePolicy({
    table: 'celebrity_categories',
    read: [{ name: 'public', rows: () => 'all', columns: '*' }],
    anonCacheSec: 300,
  }),
];

// ── RPCs ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const rpcs: RpcDefinition[] = [
  defineRpc({ name: 'validate_referral_code', access: 'anon', handler: validateReferralCode }),
  defineRpc({ name: 'get_my_referrals', access: 'user', handler: getMyReferrals }),
  defineRpc({ name: 'get_my_referral_history', access: 'user', handler: getMyReferralHistory }),
];
