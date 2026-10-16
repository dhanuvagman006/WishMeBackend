/**
 * Table policies and RPCs for the celebrities domain. See ../policy.ts for the model and CONTRIBUTING.md for the rules.
 * Owned tables are listed in docs/POLICY_OWNERSHIP.md; each table has exactly one policy in exactly one file.
 *
 * Money and anything that needs a database check run through custom handlers in src/domains/celebrities/.
 * Column names and constraints follow the production schema (Supabase audit export, 16 Oct 2026); test/fixtures/
 * celebrities.sql reproduces the parts these policies use, and notes the production triggers the handlers rely on.
 */
import { z } from 'zod';
import type { Deps } from '../../../deps.js';
import { AppError, badRequest, forbidden } from '../../../lib/errors.js';
import { sql, type Sql } from '../../../lib/sql.js';
import { createBooking, updateBookings } from '../../../domains/celebrities/bookings.js';
import {
  deleteLovedOnes,
  followCelebrity,
  insertMedia,
  insertOccasionBooking,
  insertOccasionWish,
  insertReview,
  readCelebrities,
  updateCelebrityProfile,
  upsertCelebritySettings,
} from '../../../domains/celebrities/catalogue.js';
import { insertMessage, isParticipant, markMessagesRead, updateConversations } from '../../../domains/celebrities/chat.js';
import { ownCelebrity, ownProfile, readAs, uuidArray } from '../../../domains/celebrities/compat.js';
import { catalogueRow, UUID_RE } from '../../../domains/celebrities/shared.js';
import { purchaseSubscription } from '../../../domains/celebrities/subscriptions.js';
import { definePolicy, defineRpc, type PolicyCtx, type RowRule, type RpcDefinition, type TablePolicy } from '../policy.js';

const CACHE_SEC = 60;

/** Columns of a celebrity anyone may see: what the catalogue, detail page and pickers read. */
const CELEBRITY_PUBLIC = [
  'id',
  'name',
  'category',
  'bio',
  'image_url',
  'video_thumbnail_url',
  'rating',
  'review_count',
  'followers',
  'location',
  'delivery_time',
  'is_verified',
  'is_active',
  // Public pickers filter on it (consent_status=eq.approved, or=(consent_status.neq.rejected,...)).
  'consent_status',
  'service_prices',
  'voice_call_price',
  'social_media',
  'vapi_voice_id',
  'vapi_phone_id',
  'created_at',
] as const;

/** A celebrity the signed-in user has dealt with stays visible to them (booking history, chats) even if delisted. */
const counterpart: RowRule = (c) => {
  const pid = c.identity.profileId;
  if (!pid) return 'none';
  return sql`(exists (select 1 from public.bookings x where x.celebrity_id = ${c.col('id')} and x.user_id = ${pid}::uuid)
    or exists (select 1 from public.celebrity_favorites x where x.celebrity_id = ${c.col('id')} and x.user_id = ${pid}::uuid)
    or exists (select 1 from public.conversations x where x.celebrity_id = ${c.col('id')} and x.user_id = ${pid}::uuid))`;
};

/** The caller is a participant of the conversation referenced by `column` (as the fan or as the celebrity). */
function inOwnConversation(c: PolicyCtx, column: string): Sql | 'none' {
  const pid = c.identity.profileId;
  const ids = c.identity.celebrityIds;
  if (!pid && ids.length === 0) return 'none';
  const asUser = pid ? sql`cv.user_id = ${pid}::uuid` : sql`false`;
  const asCelebrity = ids.length ? sql`cv.celebrity_id = any(${uuidArray(ids)})` : sql`false`;
  return sql`exists (select 1 from public.conversations cv where cv.id = ${c.col(column)} and (${asUser} or ${asCelebrity}))`;
}

const participant: RowRule = (c) => {
  const user = ownProfile(c, 'user_id');
  const celeb = ownCelebrity(c, 'celebrity_id');
  if (user === 'none') return celeb;
  if (celeb === 'none') return user;
  return sql`(${user} or ${celeb})`;
};

function zodCheck<T>(schema: z.ZodType<T>) {
  return (row: Record<string, unknown>) => {
    const r = schema.safeParse(row);
    if (!r.success) {
      const issue = r.error.issues[0]!;
      throw new AppError(400, '22023', `Invalid ${issue.path.join('.') || 'row'}: ${issue.message}`);
    }
    Object.assign(row, r.data);
  };
}

const ownCelebrityCheck = (row: Record<string, unknown>, c: PolicyCtx) => {
  if (typeof row.celebrity_id !== 'string' || !c.identity.celebrityIds.includes(row.celebrity_id)) {
    throw forbidden('You can only manage your own celebrity profile', '42501');
  }
};

// ── celebrities ──────────────────────────────────────────────────────────────────────────────────────────────

const celebrities = definePolicy({
  table: 'celebrities',
  read: [
    { name: 'catalogue', rows: (c) => catalogueRow(c.col), columns: CELEBRITY_PUBLIC },
    { name: 'counterpart', rows: counterpart, columns: CELEBRITY_PUBLIC },
    // The celebrity's own row, every column (balance, consent documents, commission): the dashboard reads select=*.
    { name: 'owner', rows: (c) => ownProfile(c, 'profile_id'), columns: '*' },
  ],
  // Used by the custom handler through compileUpdate; the handler validates values and storage URLs first.
  update: {
    rows: (c) => ownProfile(c, 'profile_id'),
    columns: ['bio', 'image_url', 'category', 'delivery_time', 'social_media', 'service_prices', 'consent_photo_url', 'consent_video_url', 'consent_status', 'consent_given_at'],
  },
  custom: {
    read: (a) => readCelebrities(a, (params) => readAs(a, params, CACHE_SEC)),
    update: updateCelebrityProfile,
  },
  anonCacheSec: CACHE_SEC,
});

// ── catalogue extras ─────────────────────────────────────────────────────────────────────────────────────────

/** Production's celebrity_events_event_type_check. */
const EVENT_TYPES = ['movie_release', 'award_show', 'concert', 'premiere', 'anniversary', 'birthday', 'other'];
const EventFields = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  // The dashboard also offers meetup / launch / charity, which the database's check rejects: stored as 'other'.
  event_type: z.string().trim().min(1).max(40).transform((v) => (EVENT_TYPES.includes(v) ? v : 'other')).optional(),
  event_date: z.string().trim().min(1).max(40).optional(),
  description: z.string().max(4_000).nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  is_public: z.boolean().optional(),
  celebrity_id: z.string().optional(),
});
const EVENT_COLUMNS = ['title', 'event_type', 'event_date', 'description', 'location', 'is_public'] as const;

const celebrityEvents = definePolicy({
  table: 'celebrity_events',
  read: [
    { name: 'public', rows: (c) => sql`${c.col('is_public')} is true`, columns: ['id', 'celebrity_id', 'title', 'event_type', 'event_date', 'description', 'location', 'is_public', 'created_at'] },
    { name: 'owner', rows: (c) => ownCelebrity(c), columns: '*' },
  ],
  insert: {
    columns: [...EVENT_COLUMNS, 'celebrity_id'],
    maxRows: 10,
    check: (row, c) => {
      ownCelebrityCheck(row, c);
      zodCheck(EventFields)(row);
      if (!row.title || !row.event_type || !row.event_date) throw badRequest('title, event_type and event_date are required');
    },
  },
  update: { rows: (c) => ownCelebrity(c), columns: EVENT_COLUMNS, check: zodCheck(EventFields) },
  delete: { rows: (c) => ownCelebrity(c) },
  anonCacheSec: CACHE_SEC,
});

const celebrityFavoritePricing = definePolicy({
  table: 'celebrity_favorite_pricing',
  // Only enabled prices are ever shown (the catalogue's embedded is_enabled filter relies on this).
  read: [
    {
      name: 'enabled',
      rows: (c) => sql`${c.col('is_enabled')} is true`,
      columns: ['id', 'celebrity_id', 'price', 'is_enabled', 'referrer_commission_percentage', 'celebrity_commission_percentage', 'created_at'],
    },
  ],
  anonCacheSec: CACHE_SEC,
});

const celebrityFavorites = definePolicy({
  table: 'celebrity_favorites',
  read: [
    { name: 'own', rows: (c) => ownProfile(c, 'user_id'), columns: '*' },
    // Followers tab: who follows, since when; not what they paid.
    { name: 'followers', rows: (c) => ownCelebrity(c), columns: ['id', 'user_id', 'celebrity_id', 'status', 'subscription_start_date', 'subscription_expires_at', 'created_at'] },
  ],
  custom: { insert: followCelebrity },
  // Only free follows can be removed by the user; a paid subscription is not undone by deleting its row (refunds and
  // cancellations go through support/admin).
  delete: { rows: (c) => { const own = ownProfile(c, 'user_id'); return own === 'none' ? own : sql`${own} and coalesce(${c.col('price_paid')}, 0) = 0`; } },
  realtime: {
    filterColumns: ['celebrity_id', 'user_id'],
    authorize: (_auth, identity, column, value) => (column === 'user_id' ? value === identity.profileId : identity.celebrityIds.includes(value)),
  },
});

const celebrityMedia = definePolicy({
  table: 'celebrity_media',
  read: [
    // is_public (default false in production) is the approval switch. The app reads `media_url`; the column is file_url.
    {
      name: 'public',
      rows: (c) => sql`${c.col('is_public')} is true`,
      columns: ['id', 'celebrity_id', 'title', 'description', 'media_type', 'file_url', 'thumbnail_url', 'is_promotional', 'is_public', 'created_at'],
    },
    { name: 'owner', rows: (c) => ownCelebrity(c), columns: '*' },
  ],
  computed: { media_url: (column) => column('file_url') },
  custom: { insert: insertMedia },
  delete: { rows: (c) => ownCelebrity(c) },
  anonCacheSec: CACHE_SEC,
});

const celebrityOccasions = definePolicy({
  table: 'celebrity_occasions',
  read: [
    {
      name: 'public',
      rows: (c) => sql`${c.col('is_public')} is true`,
      columns: ['id', 'celebrity_id', 'occasion_name', 'occasion_type', 'occasion_date', 'is_public', 'auto_reply_enabled', 'created_at'],
    },
    { name: 'owner', rows: (c) => ownCelebrity(c), columns: '*' },
  ],
  anonCacheSec: CACHE_SEC,
});

const celebrityReviews = definePolicy({
  table: 'celebrity_reviews',
  read: [
    // Reviewer identity is shown through the profiles embed (first/last name), not the raw user id.
    { name: 'public', rows: () => 'all', columns: ['id', 'celebrity_id', 'rating', 'review_text', 'created_at'] },
    { name: 'reviewer', rows: (c) => ownProfile(c, 'user_id'), columns: '*' },
    { name: 'celebrity', rows: (c) => ownCelebrity(c), columns: '*' },
  ],
  computed: { comment: (column) => column('review_text') },
  custom: { insert: insertReview },
  anonCacheSec: CACHE_SEC,
});

const celebritySettings = definePolicy({
  table: 'celebrity_settings',
  read: [{ name: 'owner', rows: (c) => ownCelebrity(c), columns: '*' }],
  // Inserts are upserts on celebrity_id (custom handler); PATCH changes the toggle only.
  custom: { insert: upsertCelebritySettings },
  update: {
    rows: (c) => ownCelebrity(c),
    columns: ['ai_auto_reply_enabled'],
    check: (row) => {
      if (typeof row.ai_auto_reply_enabled !== 'boolean') throw badRequest('ai_auto_reply_enabled must be true or false');
    },
  },
});
// ── bookings and chat ────────────────────────────────────────────────────────────────────────────────────────

const bookings = definePolicy({
  table: 'bookings',
  read: [
    { name: 'customer', rows: (c) => ownProfile(c, 'user_id'), columns: '*' },
    { name: 'celebrity', rows: (c) => ownCelebrity(c), columns: '*' },
  ],
  custom: { insert: createBooking, update: updateBookings },
  realtime: {
    filterColumns: ['user_id', 'celebrity_id'],
    authorize: (_auth, identity, column, value) => (column === 'user_id' ? !!identity.profileId && value === identity.profileId : identity.celebrityIds.includes(value)),
  },
});

const conversations = definePolicy({
  table: 'conversations',
  read: [{ name: 'participant', rows: participant, columns: '*' }],
  // The app reads last_message_text, which production never had: served from the newest message of the conversation.
  computed: {
    last_message_text: (column) =>
      sql`(select m.message_text from public.messages m where m.conversation_id = ${column('id')} order by m.created_at desc limit 1)`,
  },
  custom: { update: updateConversations },
  realtime: {
    filterColumns: ['celebrity_id', 'user_id'],
    authorize: (_auth, identity, column, value) => (column === 'user_id' ? !!identity.profileId && value === identity.profileId : identity.celebrityIds.includes(value)),
  },
});

const messages = definePolicy({
  table: 'messages',
  read: [{ name: 'participant', rows: (c) => inOwnConversation(c, 'conversation_id'), columns: '*' }],
  // Read markers only, and only on messages the other side sent (applied by the custom handler via compileUpdate).
  update: {
    rows: (c) => {
      const conv = inOwnConversation(c, 'conversation_id');
      if (conv === 'none') return conv;
      const pid = c.identity.profileId;
      return pid ? sql`${conv} and ${c.col('sender_id')} is distinct from ${pid}::uuid` : conv;
    },
    columns: ['is_read'],
  },
  custom: { insert: insertMessage, update: markMessagesRead },
  realtime: {
    filterColumns: ['conversation_id'],
    authorize: async (auth, identity, _column, value, deps) => {
      if (auth.kind === 'anon' || !UUID_RE.test(value)) return false;
      return isParticipant(deps.db, value, identity.profileId, identity.celebrityIds);
    },
  },
});

// ── occasions and loved ones ─────────────────────────────────────────────────────────────────────────────────

const occasions = definePolicy({
  table: 'occasions',
  read: [{ name: 'public', rows: () => 'all', columns: ['id', 'name', 'description', 'date', 'image_url', 'is_active', 'is_featured', 'created_at'] }],
  anonCacheSec: CACHE_SEC,
});

const OccasionItem = z.object({
  id: z.string().max(64),
  name: z.string().max(100),
  date: z.string().max(20).nullable().optional(),
  type: z.string().max(40).nullable().optional(),
});
const LovedOneFields = z.object({
  first_name: z.string().trim().min(1).max(100).optional(),
  last_name: z.string().trim().max(100).nullable().optional(),
  email: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  date_of_birth: z.string().max(20).nullable().optional(),
  relationship: z.string().trim().max(40).nullable().optional(),
  notes: z.string().max(2_000).nullable().optional(),
  // Non-arrays are coerced to [] by the app; the server only stores arrays.
  occasions: z.array(OccasionItem).max(50).optional(),
  user_id: z.string().optional(),
});
const LOVED_ONE_COLUMNS = ['first_name', 'last_name', 'email', 'phone', 'date_of_birth', 'relationship', 'notes', 'occasions'] as const;

const lovedOnes = definePolicy({
  table: 'loved_ones',
  read: [{ name: 'own', rows: (c) => ownProfile(c, 'user_id'), columns: '*' }],
  insert: {
    columns: LOVED_ONE_COLUMNS,
    set: (c) => ({ user_id: c.identity.profileId }),
    maxRows: 20,
    check: (row, c) => {
      if (!c.identity.profileId) throw forbidden('A profile is required', '42501');
      zodCheck(LovedOneFields)(row);
      if (!row.first_name) throw badRequest('first_name is required');
    },
  },
  update: { rows: (c) => ownProfile(c, 'user_id'), columns: LOVED_ONE_COLUMNS, check: zodCheck(LovedOneFields) },
  custom: { delete: deleteLovedOnes },
});

/** Production's occasion_alerts_occasion_type_check. */
const OCCASION_TYPES = ['birthday', 'anniversary', 'wedding', 'festival', 'other', 'custom', 'celebrity_event'] as const;
const AlertFields = z.object({
  loved_one_id: z.string().regex(UUID_RE).nullable().optional(),
  celebrity_id: z.string().regex(UUID_RE).nullable().optional(),
  occasion_name: z.string().trim().min(1).max(100).optional(),
  occasion_type: z.enum(OCCASION_TYPES).optional(),
  occasion_date: z.string().max(20).optional(),
  alert_enabled: z.boolean().optional(),
  auto_send_enabled: z.boolean().optional(),
  alert_days_before: z.number().int().min(0).max(60).optional(),
  reminder_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  user_id: z.string().optional(),
});
const ALERT_COLUMNS = ['loved_one_id', 'celebrity_id', 'occasion_name', 'occasion_type', 'occasion_date', 'alert_enabled', 'auto_send_enabled', 'alert_days_before', 'reminder_time'] as const;

/** An alert may only point at the caller's own loved one. */
async function ownLovedOne(row: Record<string, unknown>, c: PolicyCtx, db: Deps['db']): Promise<void> {
  if (row.loved_one_id === undefined || row.loved_one_id === null) return;
  const found = await db`select 1 from public.loved_ones where id = ${String(row.loved_one_id)} and user_id = ${c.identity.profileId}`;
  if (!found.length) throw forbidden('You can only add alerts for your own loved ones', '42501');
}

const occasionAlerts = definePolicy({
  table: 'occasion_alerts',
  read: [{ name: 'own', rows: (c) => ownProfile(c, 'user_id'), columns: '*' }],
  insert: {
    columns: ALERT_COLUMNS,
    set: (c) => ({ user_id: c.identity.profileId }),
    maxRows: 20,
    check: async (row, c, deps) => {
      if (!c.identity.profileId) throw forbidden('A profile is required', '42501');
      zodCheck(AlertFields)(row);
      if (!row.occasion_name) throw badRequest('occasion_name is required');
      await ownLovedOne(row, c, deps.db);
    },
  },
  update: {
    rows: (c) => ownProfile(c, 'user_id'),
    columns: ALERT_COLUMNS,
    check: async (row, c, deps) => {
      zodCheck(AlertFields)(row);
      await ownLovedOne(row, c, deps.db);
    },
  },
  delete: { rows: (c) => ownProfile(c, 'user_id') },
  upsertOn: [['user_id', 'loved_one_id', 'occasion_name']],
});

const occasionBookings = definePolicy({
  table: 'occasion_bookings',
  read: [{ name: 'own', rows: (c) => ownProfile(c, 'user_id'), columns: '*' }],
  custom: { insert: insertOccasionBooking },
});

const occasionWishes = definePolicy({
  table: 'occasion_wishes',
  read: [{ name: 'own', rows: (c) => ownProfile(c, 'user_id'), columns: '*' }],
  custom: { insert: insertOccasionWish },
});

export const tables: TablePolicy[] = [
  celebrities,
  celebrityEvents,
  celebrityFavoritePricing,
  celebrityFavorites,
  celebrityMedia,
  celebrityOccasions,
  celebrityReviews,
  celebritySettings,
  bookings,
  conversations,
  messages,
  occasions,
  lovedOnes,
  occasionAlerts,
  occasionBookings,
  occasionWishes,
];

export const rpcs: RpcDefinition[] = [defineRpc({ name: 'purchase_celebrity_subscription', access: 'user', handler: purchaseSubscription })];
