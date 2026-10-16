/**
 * Custom handlers for the celebrity catalogue and the user's own occasion data: the celebrity's self-service profile
 * update, promo media, reviews, free follows, occasion bookings and wishes, and deleting loved ones with their alerts.
 */
import { z } from 'zod';
import { compileRead, compileUpdate, filtersSql } from '../../compat/postgrest/compiler.js';
import { parseRead, parseSelect, pgrstError } from '../../compat/postgrest/parser.js';
import type { Filter } from '../../compat/postgrest/ast.js';
import type { CompatResult, CustomArgs } from '../../compat/postgrest/policy.js';
import { run } from '../../lib/db.js';
import { AppError, badRequest, conflict, forbidden } from '../../lib/errors.js';
import { sql } from '../../lib/sql.js';
import { asCaller, checkStorageUrl, compileEnv, insertRow, objectBody, represent, requireProfile, safeFolderName, uuidArray } from './compat.js';
import { availableCelebrity, hasActiveSubscription } from './shared.js';

function parse<T>(schema: z.ZodType<T>, body: unknown, table: string): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    if (issue.code === 'unrecognized_keys') throw new AppError(403, '42501', `permission denied to write column "${issue.keys[0]}" of ${table}`);
    throw new AppError(400, '22023', `Invalid ${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return r.data;
}

function single(body: unknown): Record<string, unknown> {
  if (Array.isArray(body)) {
    if (body.length !== 1) throw pgrstError(400, 'PGRST102', 'Insert one row per request');
    return objectBody(body[0]);
  }
  return objectBody(body);
}

// ── celebrities: self-service profile ─────────────────────────────────────────────────────────────────────────

// service_prices values are whole rupees: bookings store integer prices.
const price = z.number().int().min(0).max(10_000_000);
const SOCIAL_KEYS = ['instagram', 'youtube', 'twitter', 'tiktok', 'facebook', 'linkedin', 'website', 'other'] as const;

const CelebrityPatch = z
  .object({
    bio: z.string().max(2_000).nullable(),
    image_url: z.string().max(1_000),
    category: z.string().trim().min(1).max(60),
    // Text in production ('24 hours'); a number from older screens is stored as its text.
    delivery_time: z.union([z.number().int().min(0).max(10_000).transform(String), z.string().trim().max(40)]).nullable(),
    social_media: z.record(z.enum(SOCIAL_KEYS), z.string().max(300)),
    service_prices: z
      .object({
        general_wish: price,
        text_message: price,
        image_promotion: price,
        video_promotion: price,
        ugc_ad: price,
        voice_call: price,
      })
      .partial()
      .strict(),
    consent_photo_url: z.string().max(1_000),
    consent_video_url: z.string().max(1_000),
    consent_status: z.literal('submitted'),
    consent_given_at: z.string().max(40),
  })
  .partial()
  .strict();

/**
 * PATCH /rest/v1/celebrities: the owner edits self-service fields only. Balances, rating, review counts, status and
 * commission are server-owned. A body of only `available_balance` (WithdrawModal after a payout request) is answered
 * as done without writing: the payout request already held the money.
 */
export async function updateCelebrityProfile(a: CustomArgs): Promise<CompatResult> {
  const body = objectBody(a.body);
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === 'available_balance') return represent(a, a.deps.db, [], 200);
  const patch: Record<string, unknown> = parse(CelebrityPatch, body, 'celebrities');
  if (Object.keys(patch).length === 0) throw pgrstError(400, 'PGRST102', 'Nothing to update');
  const filters: Filter[] = parseRead(a.params).where;
  if (filters.length === 0) throw pgrstError(400, '21000', 'UPDATE requires a WHERE clause');
  const ids = a.identity.celebrityIds;
  if (a.auth.kind === 'anon' || ids.length === 0) return represent(a, a.deps.db, [], 200);

  const names = await a.deps.db<{ id: string; name: string }[]>`select id::text, name from public.celebrities where id = any(${`{${ids.join(',')}}`}::text::uuid[])`;
  if (patch.image_url !== undefined) {
    // ContentTab uploads to celebrity-avatars/<name with underscores, lower case>/avatar/...
    patch.image_url = checkStorageUrl(a.deps, patch.image_url, 'celebrity-avatars', [...ids, ...names.map((n) => safeFolderName(n.name))], 'image_url');
  }
  for (const k of ['consent_photo_url', 'consent_video_url'] as const) {
    if (patch[k] !== undefined) patch[k] = checkStorageUrl(a.deps, patch[k], 'verification-docs', ids, k);
  }
  if (patch.consent_status !== undefined) {
    if (!patch.consent_photo_url || !patch.consent_video_url) throw badRequest('Upload both the consent photo and video before submitting');
    // The device clock is not evidence; the server stamps the submission.
    patch.consent_given_at = new Date().toISOString();
    // An approved consent is never moved back to 'submitted' by the celebrity.
    filters.push({
      kind: 'group',
      op: 'or',
      negate: false,
      items: [
        { kind: 'cond', column: 'consent_status', op: 'is', negate: false, value: 'null' },
        { kind: 'cond', column: 'consent_status', op: 'eq', negate: true, value: 'approved' },
      ],
    });
  } else if (patch.consent_given_at !== undefined) {
    delete patch.consent_given_at;
  }
  if (Object.keys(patch).length === 0) return represent(a, a.deps.db, [], 200);

  const select = a.prefer.returnRepresentation ? parseSelect(a.params.get('select') ?? undefined) : null;
  const compiled = compileUpdate(compileEnv(a), 'celebrities', patch, filters, select);
  const res = await asCaller(a, (tx) => run<{ body: string; n: number }>(tx, compiled.query));
  if (!select) return { status: 204 };
  const out = res[0]?.body ?? '[]';
  if (!a.single) return { status: 200, body: out };
  if ((res[0]?.n ?? 0) !== 1) throw pgrstError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');
  return { status: 200, body: JSON.stringify((JSON.parse(out) as unknown[])[0]) };
}

/** GET /rest/v1/celebrities: the catalogue's `celebrity_favorite_pricing.is_enabled=eq.true` embed filter. */
export async function readCelebrities(a: CustomArgs, readAs: (params: URLSearchParams) => Promise<CompatResult>): Promise<CompatResult | 'default'> {
  const key = 'celebrity_favorite_pricing.is_enabled';
  if (!a.params.has(key)) return 'default';
  // The pricing policy only ever reveals enabled rows, so this embedded filter is already implied; the engine does not
  // support filters on embedded resources, so it is dropped rather than rejected. Any other value is refused.
  if (a.params.getAll(key).some((v) => v !== 'eq.true')) throw pgrstError(400, 'PGRST100', `Filters on embedded resources are not supported (${key})`);
  const params = new URLSearchParams(a.params);
  params.delete(key);
  return readAs(params);
}

// ── celebrity_settings ───────────────────────────────────────────────────────────────────────────────────────

const SettingsRow = z.object({ celebrity_id: z.string().uuid(), ai_auto_reply_enabled: z.boolean().optional() }).strict();

/**
 * POST /rest/v1/celebrity_settings. MessagesTab upserts with `Prefer: resolution=merge-duplicates` but no on_conflict,
 * which PostgREST resolves on the primary key, so the second toggle hit the unique celebrity_id and failed. Merges on
 * celebrity_id here, for the caller's own celebrity only.
 */
export async function upsertCelebritySettings(a: CustomArgs): Promise<CompatResult> {
  requireProfile(a.auth, a.identity);
  const s = parse(SettingsRow, single(a.body), 'celebrity_settings');
  if (!a.identity.celebrityIds.includes(s.celebrity_id)) throw forbidden('You can only manage your own celebrity profile', '42501');
  const conflict = a.params.get('on_conflict');
  if (conflict && conflict !== 'celebrity_id') throw new AppError(403, '42501', `upsert on (${conflict}) is not allowed for celebrity_settings`);
  const merge = a.prefer.mergeDuplicates || !!conflict;
  const enabled = s.ai_auto_reply_enabled ?? false;
  const id = await asCaller(a, async (tx) => {
    const rows = merge
      ? await tx<{ id: string }[]>`
          insert into public.celebrity_settings (celebrity_id, ai_auto_reply_enabled) values (${s.celebrity_id}, ${enabled})
          on conflict (celebrity_id) do update set ai_auto_reply_enabled = excluded.ai_auto_reply_enabled, updated_at = now()
          returning id::text`
      : await tx<{ id: string }[]>`
          insert into public.celebrity_settings (celebrity_id, ai_auto_reply_enabled) values (${s.celebrity_id}, ${enabled}) returning id::text`;
    return rows[0]!.id;
  });
  return represent(a, a.deps.db, [id], 201);
}

// ── celebrity_media ──────────────────────────────────────────────────────────────────────────────────────────

const NewMedia = z
  .object({
    celebrity_id: z.string().uuid(),
    media_url: z.string().max(1_000).optional(),
    file_url: z.string().max(1_000).optional(),
    media_type: z.enum(['photo', 'image', 'video']),
    thumbnail_url: z.string().max(1_000).nullable().optional(),
    title: z.string().trim().max(200).nullable().optional(),
    description: z.string().max(2_000).nullable().optional(),
  })
  .strict();

/**
 * POST /rest/v1/celebrity_media: own celebrity, files from this server's promotional-content bucket only. The
 * dashboard sends `media_url`; production's column is `file_url` (and `title` is required), so the insert that always
 * failed there is mapped onto the real columns. New media stays private (is_public defaults to false) until approved.
 */
export async function insertMedia(a: CustomArgs): Promise<CompatResult> {
  const profileId = requireProfile(a.auth, a.identity);
  const m = parse(NewMedia, single(a.body), 'celebrity_media');
  if (!a.identity.celebrityIds.includes(m.celebrity_id)) throw forbidden('You can only add media to your own profile', '42501');
  await a.deps.limiter.hit('celebrity-media', profileId, { limit: 30, windowSec: 3600 });
  const name = (await a.deps.db<{ name: string }[]>`select name from public.celebrities where id = ${m.celebrity_id}`)[0]?.name ?? '';
  const folders = [m.celebrity_id, safeFolderName(name)];
  const mediaUrl = checkStorageUrl(a.deps, m.file_url ?? m.media_url, 'promotional-content', folders, 'media_url');
  const thumb = m.thumbnail_url ? checkStorageUrl(a.deps, m.thumbnail_url, 'promotional-content', folders, 'thumbnail_url') : null;
  const id = await asCaller(a, (tx) =>
    insertRow(a.deps, tx, 'celebrity_media', {
      celebrity_id: m.celebrity_id,
      file_url: mediaUrl,
      media_type: m.media_type === 'image' ? 'photo' : m.media_type,
      thumbnail_url: thumb,
      title: m.title || (m.media_type === 'video' ? 'Promotional video' : 'Promotional photo'),
      description: m.description ?? null,
      is_promotional: true,
    }),
  );
  return represent(a, a.deps.db, [id], 201);
}

// ── celebrity_reviews ────────────────────────────────────────────────────────────────────────────────────────

const NewReview = z
  .object({
    booking_id: z.string().uuid(),
    celebrity_id: z.string().uuid().optional(),
    user_id: z.string().uuid().optional(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(2_000).nullable().optional(),
    review_text: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict();

/**
 * POST /rest/v1/celebrity_reviews: only for the caller's own completed booking, once per booking. Production's
 * update_celebrity_rating trigger recomputes celebrities.rating / review_count. The text column is review_text; a
 * `comment` field (what the celebrity page reads) is accepted as its alias. (The current app has no review form.)
 */
export async function insertReview(a: CustomArgs): Promise<CompatResult> {
  const profileId = requireProfile(a.auth, a.identity);
  const r = parse(NewReview, single(a.body), 'celebrity_reviews');
  if (r.user_id && r.user_id !== profileId) throw forbidden('You can only review as yourself', '42501');
  await a.deps.limiter.hit('celebrity-review', profileId, { limit: 10, windowSec: 3600 });
  const text = r.review_text ?? r.comment ?? null;
  const id = await a.deps.db.begin(async (tx) => {
    const b = (await tx<{ user_id: string; celebrity_id: string; status: string }[]>`
      select user_id::text, celebrity_id::text, status from public.bookings where id = ${r.booking_id} for update`)[0];
    if (!b || b.user_id !== profileId) throw forbidden('You can only review your own bookings', '42501');
    if (r.celebrity_id && r.celebrity_id !== b.celebrity_id) throw badRequest('This booking is for a different celebrity');
    if (b.status !== 'completed') throw badRequest('You can review a booking once it is completed', 'booking_not_completed');
    const dup = await tx`select 1 from public.celebrity_reviews where booking_id = ${r.booking_id} limit 1`;
    if (dup.length) throw conflict('You have already reviewed this booking', '23505');
    const reviewId = await insertRow(a.deps, tx, 'celebrity_reviews', {
      celebrity_id: b.celebrity_id,
      user_id: profileId,
      booking_id: r.booking_id,
      rating: r.rating,
      review_text: text,
    });
    return reviewId;
  });
  return represent(a, a.deps.db, [id], 201);
}

// ── celebrity_favorites: free follows ────────────────────────────────────────────────────────────────────────

const NewFollow = z
  .object({ celebrity_id: z.string().uuid(), user_id: z.string().uuid().optional(), status: z.literal('active').optional() })
  .strict();

/**
 * POST /rest/v1/celebrity_favorites: follow a celebrity that has no paid subscription. An active favourite is the
 * subscription itself, so celebrities with enabled pricing can only be followed through
 * purchase_celebrity_subscription. (The current app never inserts here.)
 */
export async function followCelebrity(a: CustomArgs): Promise<CompatResult> {
  const profileId = requireProfile(a.auth, a.identity);
  const f = parse(NewFollow, single(a.body), 'celebrity_favorites');
  if (f.user_id && f.user_id !== profileId) throw forbidden('You can only follow as yourself', '42501');
  await a.deps.limiter.hit('celebrity-follow', profileId, { limit: 60, windowSec: 3600 });
  const id = await a.deps.db.begin(async (tx) => {
    await tx`select id from public.profiles where id = ${profileId} for update`;
    if (!(await availableCelebrity(tx, f.celebrity_id))) throw badRequest('This celebrity is not available', 'celebrity_unavailable');
    const paid = await tx`select 1 from public.celebrity_favorite_pricing where celebrity_id = ${f.celebrity_id} and is_enabled is true limit 1`;
    if (paid.length) throw forbidden('Subscribe to follow this celebrity', 'subscription_required');
    const existing = (await tx<{ id: string; status: string }[]>`
      select id::text, status from public.celebrity_favorites where user_id = ${profileId} and celebrity_id = ${f.celebrity_id} limit 1`)[0];
    if (existing) {
      if (existing.status !== 'active') await tx`update public.celebrity_favorites set status = 'active' where id = ${existing.id}`;
      return existing.id;
    }
    // payment_method is limited to wallet / razorpay in production, so a free follow leaves it null.
    return insertRow(a.deps, tx, 'celebrity_favorites', { user_id: profileId, celebrity_id: f.celebrity_id, status: 'active', price_paid: 0, payment_method: null });
  });
  return represent(a, a.deps.db, [id], 201);
}

// ── occasion_bookings / occasion_wishes ──────────────────────────────────────────────────────────────────────

const NewOccasionBooking = z
  .object({
    user_id: z.string().uuid().optional(),
    occasion_id: z.string().uuid(),
    celebrity_id: z.string().uuid(),
    booking_type: z.enum(['video', 'greeting_card']),
    recipient_name: z.string().trim().min(1).max(100),
    recipient_email: z.union([z.string().trim().email().max(200), z.literal('')]).nullable().optional(),
    recipient_phone: z.string().trim().max(20).nullable().optional(),
    message: z.string().trim().max(1_000),
    price: z.number().optional(),
    status: z.literal('pending').optional(),
  })
  .strict();

/**
 * POST /rest/v1/occasion_bookings. Occasion wishes are a perk of an active subscription and free (the app always sends
 * price 0 and never charges, and production charges nothing either), so the server requires the subscription and forces price 0 instead of
 * trusting the field. They start costly AI generation, hence the rate limit.
 */
export async function insertOccasionBooking(a: CustomArgs): Promise<CompatResult> {
  const profileId = requireProfile(a.auth, a.identity);
  const b = parse(NewOccasionBooking, single(a.body), 'occasion_bookings');
  if (b.user_id && b.user_id !== profileId) throw forbidden('You can only book for yourself', '42501');
  await a.deps.limiter.hit('occasion-booking', profileId, { limit: 10, windowSec: 3600 }, 'Too many occasion bookings. Please try again later.');
  const occasion = await a.deps.db`select 1 from public.occasions where id = ${b.occasion_id} and is_active is true`;
  if (!occasion.length) throw badRequest('This occasion is not available', 'occasion_unavailable');
  if (!(await availableCelebrity(a.deps.db, b.celebrity_id))) throw badRequest('This celebrity is not available', 'celebrity_unavailable');
  if (!(await hasActiveSubscription(a.deps.db, profileId, b.celebrity_id))) {
    throw badRequest('Subscribe to this celebrity to book an occasion wish', 'subscription_required');
  }
  const id = await asCaller(a, (tx) =>
    insertRow(a.deps, tx, 'occasion_bookings', {
      user_id: profileId,
      occasion_id: b.occasion_id,
      celebrity_id: b.celebrity_id,
      booking_type: b.booking_type,
      recipient_name: b.recipient_name,
      recipient_email: b.recipient_email || null,
      recipient_phone: b.recipient_phone || null,
      message: b.message,
      price: 0,
      status: 'pending',
    }),
  );
  return represent(a, a.deps.db, [id], 201);
}

const NewOccasionWish = z
  .object({
    user_id: z.string().uuid().optional(),
    celebrity_id: z.string().uuid(),
    occasion_id: z.string().uuid(),
    message: z.string().trim().min(10).max(500),
  })
  .strict();

/** POST /rest/v1/occasion_wishes: a subscriber's wish on a celebrity's public occasion. Free. */
export async function insertOccasionWish(a: CustomArgs): Promise<CompatResult> {
  const profileId = requireProfile(a.auth, a.identity);
  const w = parse(NewOccasionWish, single(a.body), 'occasion_wishes');
  if (w.user_id && w.user_id !== profileId) throw forbidden('You can only send wishes as yourself', '42501');
  await a.deps.limiter.hit('occasion-wish', profileId, { limit: 20, windowSec: 3600 }, 'Too many wishes. Please try again later.');
  const occ = await a.deps.db`
    select 1 from public.celebrity_occasions where id = ${w.occasion_id} and celebrity_id = ${w.celebrity_id} and is_public is true`;
  if (!occ.length) throw badRequest('This occasion is not available', 'occasion_unavailable');
  if (!(await hasActiveSubscription(a.deps.db, profileId, w.celebrity_id))) {
    throw badRequest('Subscribe to this celebrity to send wishes', 'subscription_required');
  }
  const id = await asCaller(a, (tx) =>
    insertRow(a.deps, tx, 'occasion_wishes', { user_id: profileId, celebrity_id: w.celebrity_id, occasion_id: w.occasion_id, message: w.message }),
  );
  return represent(a, a.deps.db, [id], 201);
}

// ── loved_ones: delete with their alerts ─────────────────────────────────────────────────────────────────────

/**
 * DELETE /rest/v1/loved_ones. The app promises "and all their occasions" but deletes only the person, so the server
 * removes the person's occasion_alerts in the same transaction (whether or not the database cascades).
 */
export async function deleteLovedOnes(a: CustomArgs): Promise<CompatResult> {
  const filters = parseRead(a.params).where;
  if (filters.length === 0) throw pgrstError(400, '21000', 'DELETE requires a WHERE clause');
  const profileId = a.identity.profileId;
  if (a.auth.kind === 'anon' || !profileId) return a.prefer.returnRepresentation ? { status: 200, body: '[]' } : { status: 204 };
  const info = a.deps.schema.table('loved_ones')!;
  const body = await asCaller(a, async (tx) => {
    const ids = (await run<{ id: string }>(tx, sql`
      select t0.id::text as id from public.loved_ones as t0
      where t0.user_id = ${profileId}::uuid and ${filtersSql(info, null, 't0', filters)} limit 101`)).map((r) => r.id);
    if (ids.length > 100) throw badRequest('Delete at most 100 people at a time');
    let out = '[]';
    if (a.prefer.returnRepresentation && ids.length) {
      const read = compileRead(compileEnv(a), 'loved_ones', {
        select: parseSelect(a.params.get('select') ?? undefined),
        where: [{ kind: 'cond', column: 'id', op: 'in', negate: false, value: ids }],
        order: [],
      }, false);
      out = (await run<{ body: string }>(tx, read.query))[0]?.body ?? '[]';
    }
    if (ids.length) {
      await run(tx, sql`delete from public.occasion_alerts where user_id = ${profileId}::uuid and loved_one_id = any(${uuidArray(ids)})`);
      await run(tx, sql`delete from public.loved_ones where id = any(${uuidArray(ids)}) and user_id = ${profileId}::uuid`);
    }
    return out;
  });
  return a.prefer.returnRepresentation ? { status: 200, body } : { status: 204 };
}
