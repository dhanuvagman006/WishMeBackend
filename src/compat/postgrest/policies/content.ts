/**
 * Table policies and RPCs for the content domain. See ../policy.ts for the model and CONTRIBUTING.md for the rules.
 * Owned tables are listed in docs/POLICY_OWNERSHIP.md; each table has exactly one policy in exactly one file.
 *
 * Ownership: every table keys on the profile id (user_id = profiles.id) except ugc_ads, which keys on the auth user id
 * (the app filters it by authUid). Celebrities read the orders and promotions addressed to their own celebrity ids
 * (dashboard), with a narrower column list. Nothing here lets a client write a price, an amount, a payment status, a
 * "done" status or a generated URL: orders and generations are created by RPCs / functions, and the few client writes
 * the app makes are intercepted by custom handlers below.
 */
import { z } from 'zod';
import type { Deps } from '../../../deps.js';
import { run } from '../../../lib/db.js';
import { AppError, badRequest, forbidden } from '../../../lib/errors.js';
import { sql } from '../../../lib/sql.js';
import { isOwnStorageUrl, bucketPrefixes } from '../../../domains/content/media.js';
import { insertRow, UUID_RE } from '../../../domains/content/rows.js';
import { createUgcAdOrder, createWishFriendOrder } from '../../../domains/content/ugc.js';
import { applyOrderPatch, deleteUnpaidOrder, loadOwnOrder, wishOrderPricePaise } from '../../../domains/content/wish-orders.js';
import { rupees } from '../../../domains/content/money.js';
import { compileRead } from '../compiler.js';
import { parseRead, pgrstError } from '../parser.js';
import type { CompatResult, CustomArgs, RealtimeRule, RowRule, RpcDefinition, TablePolicy, WriteRule } from '../policy.js';
import { defineRpc, definePolicy } from '../policy.js';

// ── shared rules ───────────────────────────────────────────────────────────────────────────────────────────────

const ownByProfile: RowRule = (c) => (c.identity.profileId ? sql`${c.col('user_id')} = ${c.identity.profileId}::text::uuid` : 'none');
const ownByAuthUser: RowRule = (c) => (c.auth.userId ? sql`${c.col('user_id')} = ${c.auth.userId}::text::uuid` : 'none');
const addressedToMyCelebrity: RowRule = (c) =>
  c.identity.celebrityIds.length ? sql`${c.col('celebrity_id')} = any(${`{${c.identity.celebrityIds.join(',')}}`}::text::uuid[])` : 'none';

/** Realtime: a user may follow their own rows (user_id = profile id), a celebrity the rows addressed to them. */
function realtimeFor(columns: readonly ('user_id' | 'celebrity_id')[]): RealtimeRule {
  return {
    filterColumns: columns,
    authorize: (_auth, identity, column, value) =>
      (column === 'user_id' && !!identity.profileId && value === identity.profileId) ||
      (column === 'celebrity_id' && identity.celebrityIds.includes(value)),
  };
}

function requireProfile(a: { auth: CustomArgs['auth']; identity: CustomArgs['identity'] }): { userId: string; profileId: string } {
  if (!a.auth.userId || !a.identity.profileId) throw new AppError(401, '42501', 'permission denied: sign in required');
  return { userId: a.auth.userId, profileId: a.identity.profileId };
}

/** The only filter the app sends when it writes these tables: `id=eq.<uuid>`. Anything else is refused. */
function idFilter(params: URLSearchParams, table: string): string {
  let id: string | null = null;
  for (const [k, v] of params) {
    if (k === 'select' || k === 'columns') continue;
    if (k === 'id' && id === null && v.startsWith('eq.') && UUID_RE.test(v.slice(3))) {
      id = v.slice(3);
      continue;
    }
    throw pgrstError(400, 'PGRST100', `Only id=eq.<uuid> filters are supported when writing ${table}`);
  }
  if (!id) throw pgrstError(400, '21000', 'A filter such as id=eq.<id> is required');
  return id;
}

function oneObject(body: unknown): Record<string, unknown> {
  const v = Array.isArray(body) && body.length === 1 ? body[0] : body;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw pgrstError(400, 'PGRST102', 'Expected one JSON object');
  return v as Record<string, unknown>;
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown, table: string): T {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  // A column the client may not write wins over other problems, as in the generic engine (403, not 400).
  const extra = r.error.issues.find((i) => i.code === 'unrecognized_keys');
  if (extra?.code === 'unrecognized_keys') {
    throw new AppError(403, '42501', `permission denied to write column "${extra.keys[0]}" of ${table}`, null, 'This column is set by the server.');
  }
  const issue = r.error.issues[0];
  throw new AppError(400, '22023', `Invalid ${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid value'}`);
}

/**
 * Answers a custom write the way PostgREST would: empty with `return=minimal` (201 for inserts, 204 otherwise), or the
 * rows as the caller's read grants show them, honouring `select` and single-object requests.
 */
async function represent(a: CustomArgs, table: string, ids: string[], status: 200 | 201): Promise<CompatResult> {
  if (!a.prefer.returnRepresentation) return { status: status === 201 ? 201 : 204 };
  let body = '[]';
  let n = 0;
  if (ids.length > 0) {
    const params = new URLSearchParams({ select: a.params.get('select') ?? '*', id: `in.(${ids.join(',')})` });
    const compiled = compileRead({ schema: a.deps.schema, policies: a.deps.policies, auth: a.auth, identity: a.identity }, table, parseRead(params), false);
    const rows = await run<{ body: string; n: number }>(a.deps.db, compiled.query);
    body = rows[0]?.body ?? '[]';
    n = rows[0]?.n ?? 0;
  }
  if (a.single) {
    if (n !== 1) throw pgrstError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${n} rows`);
    return { status, body: JSON.stringify((JSON.parse(body) as unknown[])[0]) };
  }
  return { status, body };
}

// ── wish_celebrity_orders ──────────────────────────────────────────────────────────────────────────────────────

/** Upload URLs must be the caller's own files in greeting-card-uploads (`<folder>/<profileId>-<ts>.<ext>`). */
function ownUploadUrl(deps: Deps, profileId: string, folder: 'ref-images' | 'user-cards' | 'user-videos') {
  return z
    .string()
    .max(1000)
    .nullish()
    .refine(
      (v) =>
        !v ||
        (isOwnStorageUrl(deps, v, 'greeting-card-uploads') &&
          bucketPrefixes(deps, 'greeting-card-uploads').some((p) => v.startsWith(`${p}${folder}/${profileId}-`))),
      { message: 'must be a file you uploaded' },
    );
}

async function insertWishOrder(a: CustomArgs): Promise<CompatResult> {
  const who = requireProfile(a);
  const deps = a.deps;
  await deps.limiter.hit('rest:wish_celebrity_orders:insert', `u:${who.userId}`, { limit: 30, windowSec: 3600 });
  const b = parse(
    z
      .object({
        celebrity_id: z.string().uuid(),
        occasion_type: z.string().trim().min(1).max(100),
        recipient_name: z.string().trim().min(1).max(100),
        message: z.string().trim().min(1).max(2000),
        card_prompt: z.string().max(1000).nullish(),
        reference_image_url: ownUploadUrl(deps, who.profileId, 'ref-images'),
        user_uploaded_card_url: ownUploadUrl(deps, who.profileId, 'user-cards'),
        user_uploaded_video_url: ownUploadUrl(deps, who.profileId, 'user-videos'),
        card_generation_type: z.enum(['ai', 'upload-card', 'upload-video']).default('ai'),
        payment_method: z.enum(['wallet', 'razorpay']).nullish(),
        // Sent by the app but owned by the server: accepted and ignored (owner from the token, price from the celebrity).
        user_id: z.unknown().optional(),
        amount_paid: z.unknown().optional(),
        discount_percentage: z.unknown().optional(),
        discount_amount: z.unknown().optional(),
        payment_status: z.unknown().optional(),
        status: z.unknown().optional(),
      })
      .strict()
      .refine((v) => v.card_generation_type !== 'upload-card' || !!v.user_uploaded_card_url, { message: 'is required', path: ['user_uploaded_card_url'] })
      .refine((v) => v.card_generation_type !== 'upload-video' || !!v.user_uploaded_video_url, { message: 'is required', path: ['user_uploaded_video_url'] })
      .refine((v) => v.card_generation_type !== 'ai' || !!v.card_prompt?.trim(), { message: 'is required', path: ['card_prompt'] }),
    oneObject(a.body),
    'wish_celebrity_orders',
  );
  const price = await wishOrderPricePaise(deps.db, b.celebrity_id);
  const row = await insertRow(deps.db, deps.schema, 'wish_celebrity_orders', {
    user_id: who.profileId,
    celebrity_id: b.celebrity_id,
    occasion_type: b.occasion_type,
    recipient_name: b.recipient_name,
    message: b.message,
    card_prompt: b.card_prompt ?? null,
    reference_image_url: b.reference_image_url ?? null,
    user_uploaded_card_url: b.user_uploaded_card_url ?? null,
    user_uploaded_video_url: b.user_uploaded_video_url ?? null,
    card_generation_type: b.card_generation_type,
    amount_paid: rupees(price),
    // No plan discount on wishes: both wish screens keep planDiscountPct at 0 and send discount 0.
    discount_percentage: 0,
    discount_amount: 0,
    payment_method: b.payment_method ?? null,
    payment_status: 'pending',
    status: 'pending',
    generation_attempts: 0,
  });
  return represent(a, 'wish_celebrity_orders', [String(row.id)], 201);
}

async function updateWishOrder(a: CustomArgs): Promise<CompatResult> {
  const who = requireProfile(a);
  const id = idFilter(a.params, 'wish_celebrity_orders');
  const b = parse(
    z
      .object({
        status: z.string().max(30).optional(),
        payment_status: z.enum(['completed', 'pending']).optional(),
        payment_method: z.enum(['wallet', 'razorpay']).optional(),
      })
      .strict(),
    oneObject(a.body),
    'wish_celebrity_orders',
  );
  const found = (await a.deps.db.begin(async (tx) => {
    const order = await loadOwnOrder(tx, id, who.profileId, true);
    if (!order) return false;
    await applyOrderPatch(tx, order, who.userId, b);
    return true;
  })) as boolean;
  return represent(a, 'wish_celebrity_orders', found ? [id] : [], 200);
}

async function deleteWishOrder(a: CustomArgs): Promise<CompatResult> {
  const who = requireProfile(a);
  const id = idFilter(a.params, 'wish_celebrity_orders');
  await a.deps.db.begin((tx) => deleteUnpaidOrder(tx, id, who.profileId));
  return a.prefer.returnRepresentation ? { status: 200, body: '[]' } : { status: 204 };
}

const ORDER_CELEB_COLUMNS = [
  'id', 'celebrity_id', 'occasion_type', 'recipient_name', 'message', 'card_prompt', 'card_generation_type', 'reference_image_url',
  'user_uploaded_card_url', 'user_uploaded_video_url', 'generated_card_image_url', 'greeting_text', 'card_approved', 'payment_status',
  'status', 'completed_at', 'created_at',
] as const;

// ── generation rows the app may only annotate ──────────────────────────────────────────────────────────────────

/**
 * photo_wishes / image_promotions: the app PATCHes a payment id it invented after recording the payment itself. The
 * server already stamped its own wishme_payment_id when it charged, so the client value is acknowledged, not stored.
 */
function acknowledgePaymentId(table: string) {
  return async (a: CustomArgs): Promise<CompatResult> => {
    const who = requireProfile(a);
    const id = idFilter(a.params, table);
    parse(z.object({ wishme_payment_id: z.string().max(60) }).strict(), oneObject(a.body), table);
    const rows = await a.deps.db.unsafe<{ id: string }[]>(`select id::text as id from public.${table} where id = $1::uuid and user_id = $2::uuid`, [id, who.profileId]);
    return represent(a, table, rows.map((r) => r.id), 200);
  };
}

// ── library_items ──────────────────────────────────────────────────────────────────────────────────────────────

const httpsUrl = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.length <= 2000 && /^https:\/\//.test(v));

const libraryInsert: WriteRule = {
  columns: ['kind', 'source_type', 'source_id', 'title', 'subtitle', 'media_url', 'file_key', 'thumbnail_url'],
  set: (c) => ({ user_id: c.identity.profileId }),
  maxRows: 1,
  check: (row, c) => {
    if (!c.identity.profileId) throw forbidden('A profile is required', '42501');
    if (row.kind !== 'video' && row.kind !== 'image') throw badRequest('kind must be video or image', '22023');
    if (typeof row.source_type !== 'string' || !/^[a-z_]{1,40}$/.test(row.source_type)) throw badRequest('Invalid source_type', '22023');
    if (typeof row.source_id !== 'string' || !UUID_RE.test(row.source_id)) throw badRequest('Invalid source_id', '22023');
    if (typeof row.title !== 'string' || row.title.length > 200) throw badRequest('Invalid title', '22023');
    if (row.subtitle != null && (typeof row.subtitle !== 'string' || row.subtitle.length > 300)) throw badRequest('Invalid subtitle', '22023');
    if (!httpsUrl(row.media_url) || !httpsUrl(row.thumbnail_url)) throw badRequest('Media URLs must be https URLs', '22023');
    if (!row.media_url && !row.file_key) throw badRequest('A library item needs a media_url or a file_key', '23514');
    if (row.file_key != null && (typeof row.file_key !== 'string' || row.file_key.length > 500)) throw badRequest('Invalid file_key', '22023');
  },
};

/**
 * A saved video's file_key is later exchanged for a signed URL (b2-get-signed-url), so a library row may only carry a
 * key that belongs to the caller's own order of that source type. Rows without a key need no lookup.
 */
async function verifyLibraryFileKey(a: CustomArgs): Promise<'default'> {
  const who = requireProfile(a);
  const row = oneObject(a.body);
  const key = row.file_key;
  if (key === null || key === undefined || key === '') return 'default';
  const sourceId = typeof row.source_id === 'string' ? row.source_id : '';
  if (typeof key !== 'string' || !UUID_RE.test(sourceId)) throw new AppError(403, '42501', 'This file cannot be saved to your library');
  const lookups: Record<string, { table: string; owner: string }> = {
    ugc_ad: { table: 'ugc_ads', owner: who.userId },
    ugc_video: { table: 'wish_friend_orders', owner: who.profileId },
    wish_friend: { table: 'wish_friend_orders', owner: who.profileId },
    booking: { table: 'bookings', owner: who.profileId },
  };
  const l = lookups[String(row.source_type)];
  const info = l ? a.deps.schema.table(l.table) : undefined;
  if (!l || !info?.columns.has('video_file_key') || !info.columns.has('user_id')) {
    throw new AppError(403, '42501', 'This file cannot be saved to your library');
  }
  const hit = await a.deps.db.unsafe(
    `select 1 from public.${l.table} where id = $1::uuid and user_id = $2::uuid and video_file_key = $3 limit 1`,
    [sourceId, l.owner, key],
  );
  if (hit.length === 0) throw new AppError(403, '42501', 'This file cannot be saved to your library');
  return 'default';
}

// ── audio history rows ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The music tabs (components/music/*Tab.tsx) POST a history row after each ElevenLabs function succeeds, with their
 * own price constant. On this server the audio functions write those rows themselves (with the server's price), so
 * the app's insert is acknowledged and dropped: 201 with an empty body, or [] under return=representation. Writing
 * it would duplicate the history (and production rejected the voice-conversion insert anyway: its columns are
 * target_voice_id / target_voice_name, not the voice_id / voice_name the app sends).
 */
function audioHistory(table: string): TablePolicy {
  return definePolicy({
    table,
    read: [{ name: 'owner', rows: ownByProfile, columns: '*' }],
    custom: {
      insert: async (a) => {
        requireProfile(a);
        return a.prefer.returnRepresentation ? { status: 201, body: '[]' } : { status: 201 };
      },
    },
  });
}
// ── policies ───────────────────────────────────────────────────────────────────────────────────────────────────

export const tables: TablePolicy[] = [
  definePolicy({
    table: 'wish_celebrity_orders',
    read: [
      { name: 'owner', rows: ownByProfile, columns: '*' },
      { name: 'celebrity', rows: addressedToMyCelebrity, columns: ORDER_CELEB_COLUMNS },
    ],
    custom: { insert: insertWishOrder, update: updateWishOrder, delete: deleteWishOrder },
    // wish-congratulations selects conversation_id, which production does not have (that select fails there today).
    // send-wish-to-celebrity keeps the conversation elsewhere, so the column reads as null until it exists.
    computed: { conversation_id: () => sql`null::uuid` },
  }),
  definePolicy({
    table: 'wish_friend_orders',
    read: [
      { name: 'owner', rows: ownByProfile, columns: '*' },
      {
        name: 'celebrity',
        rows: addressedToMyCelebrity,
        columns: ['id', 'celebrity_id', 'order_type', 'recipient_name', 'occasion', 'relationship', 'tone', 'prompt', 'aspect_ratio', 'status', 'created_at'],
      },
    ],
    realtime: realtimeFor(['user_id']),
  }),
  definePolicy({
    table: 'ugc_ads',
    read: [
      { name: 'owner', rows: ownByAuthUser, columns: '*' },
      {
        name: 'celebrity',
        rows: addressedToMyCelebrity,
        columns: ['id', 'celebrity_id', 'product_name', 'product_description', 'product_image_url', 'prompt', 'aspect_ratio', 'status', 'created_at'],
      },
    ],
  }),
  definePolicy({
    table: 'image_promotions',
    read: [
      { name: 'owner', rows: ownByProfile, columns: '*' },
      {
        name: 'celebrity',
        rows: addressedToMyCelebrity,
        columns: ['id', 'user_id', 'celebrity_id', 'concept', 'branding_details', 'price_paid', 'generated_image_url', 'status', 'completed_at', 'created_at'],
      },
    ],
    custom: { update: acknowledgePaymentId('image_promotions') },
    realtime: realtimeFor(['celebrity_id', 'user_id']),
  }),
  definePolicy({
    table: 'photo_wishes',
    read: [{ name: 'owner', rows: ownByProfile, columns: '*' }],
    custom: { update: acknowledgePaymentId('photo_wishes') },
    // The Bookings "Photo" tab reads these names; production stores the same values under occasion / wish_message /
    // edited_image_url / amount_charged.
    computed: {
      occasion_type: (col) => col('occasion'),
      message: (col) => col('wish_message'),
      output_url: (col) => sql`case when ${col('edited_image_url')} like 'https://%' then ${col('edited_image_url')} end`,
      credits_used: (col) => col('amount_charged'),
    },
  }),
  definePolicy({
    table: 'greeting_card_generations',
    read: [{ name: 'owner', rows: ownByProfile, columns: '*' }],
    update: { rows: ownByProfile, columns: ['saved_to_library'] },
  }),
  definePolicy({
    table: 'library_items',
    read: [{ name: 'owner', rows: ownByProfile, columns: '*' }],
    insert: libraryInsert,
    upsertOn: [['user_id', 'source_type', 'source_id']],
    delete: { rows: ownByProfile },
    custom: { insert: verifyLibraryFileKey },
  }),
  definePolicy({
    table: 'music_generations',
    read: [{ name: 'owner', rows: ownByProfile, columns: '*' }],
    // The Bookings "Music" tab reads title / audio_url / has_vocals; production has song_title, song_url /
    // download_url and generation_type.
    computed: {
      title: (col) => col('song_title'),
      audio_url: (col) => sql`coalesce(${col('song_url')}, ${col('download_url')})`,
      has_vocals: (col) => sql`(${col('generation_type')}::text = 'with_lyrics')`,
    },
    realtime: realtimeFor(['user_id']),
  }),
  audioHistory('tts_generations'),
  audioHistory('voice_conversion_generations'),
  audioHistory('sound_effect_generations'),
  audioHistory('audio_isolation_generations'),
  audioHistory('image_music_generations'),
  definePolicy({
    table: 'voice_call_wishes',
    // Vapi call configuration and raw webhook payloads are server data, not shown to the caller.
    hiddenColumns: ['webhook_payload', 'call_config'],
    read: [{ name: 'owner', rows: ownByProfile, columns: '*' }],
  }),
];

export const rpcs: RpcDefinition[] = [
  defineRpc({
    name: 'create_wish_friend_order',
    access: 'user',
    handler: async (c) => ({ status: 200, body: await createWishFriendOrder(c.deps, c.auth, c.identity, c.args) }),
  }),
  defineRpc({
    name: 'create_ugc_ad_order',
    access: 'user',
    handler: async (c) => ({ status: 200, body: await createUgcAdOrder(c.deps, c.auth, c.identity, c.args) }),
  }),
];
