/**
 * create_wish_friend_order / create_ugc_ad_order: orders fulfilled by the WishMe team (not AI). Same contract as the
 * production SQL functions (audit export): price = celebrity service_prices (general_wish for video wishes, ugc_ad for
 * UGC) falling back to platform_settings ugc_video_price / ugc_ads_price, minus the buyer's plan discount, rounded to
 * whole rupees; the order and the wallet debit are written in one transaction; the inserted row is returned.
 * Differences on purpose: the debit goes through the ledger (balance lock, idempotency key) instead of a raw
 * wallet_transactions insert, and image URLs must be the caller's own uploads.
 *
 * wish_friend_orders.user_id is the profile id; ugc_ads.user_id is the auth user id (as in production).
 */
import { z } from 'zod';
import type { AuthContext, Identity } from '../../auth/context.js';
import type { Deps } from '../../deps.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { settingPricePaise } from '../pricing.js';
import { bucketPrefixes } from './media.js';
import { celebrityPricePaise, chargeWallet, orderableCelebrity, priceForUser, rupees, type CelebrityPricing } from './money.js';
import { insertRow, type Row } from './rows.js';

const RPC_LIMIT = { limit: 10, windowSec: 600 };
const MAX_DETAILS_BYTES = 19_000;

/** HeyGen stock avatar / voice the production RPC suggests when the celebrity has none (public ids, not secrets). */
const DEFAULT_AVATAR_ID = 'Angela-inblackskirt-20220820';
const DEFAULT_VOICE_ID = '1bd001e7e50f421d891986aad5158bc8';

const text = (max: number) => z.string().max(max).optional().transform((v) => (v ?? '').trim());
const required = (max: number, what: string) => z.string().max(max).transform((v) => v.trim()).pipe(z.string().min(1, `${what} is required`));
const details = z
  .record(z.unknown())
  .nullish()
  .transform((d) => d ?? {})
  .refine((d) => JSON.stringify(d).length <= MAX_DETAILS_BYTES, { message: 'Order details are invalid or too large' });

/** '' or a public URL the caller uploaded to promotional-content under their own auth uid folder. */
function promoUrl(deps: Deps, userId: string) {
  return z
    .string()
    .max(1000)
    .nullish()
    .transform((v) => (v ?? '').trim())
    .refine((v) => v === '' || (!v.includes('..') && bucketPrefixes(deps, 'promotional-content').some((p) => v.startsWith(`${p}${userId}/`))), {
      message: 'must be an image you uploaded',
    });
}

function parseArgs<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    const field = first?.path.join('.');
    throw new AppError(400, 'P0001', field ? `Invalid ${field}: ${first?.message ?? 'invalid value'}` : (first?.message ?? 'Invalid arguments'));
  }
  return r.data;
}

const nullIfEmpty = (v: string) => (v === '' ? null : v);

/** Profile from the token (never from the arguments) and a per-user rate limit. */
async function caller(deps: Deps, auth: AuthContext, identity: Identity, rpc: string): Promise<{ userId: string; profileId: string }> {
  if (!auth.userId || !identity.profileId) throw forbidden('Not signed in');
  await deps.limiter.hit(`rpc:${rpc}`, `u:${auth.userId}`, RPC_LIMIT);
  return { userId: auth.userId, profileId: identity.profileId };
}

export async function createWishFriendOrder(deps: Deps, auth: AuthContext, identity: Identity, args: Record<string, unknown>): Promise<Row> {
  const who = await caller(deps, auth, identity, 'create_wish_friend_order');
  const a = parseArgs(
    z
      .object({
        p_order_type: z.enum(['video_wish', 'ugc_video'], { message: 'Invalid order type' }),
        p_celebrity_id: z.string().uuid(),
        p_recipient_name: required(100, 'Name'),
        p_occasion: required(100, 'Occasion'),
        p_relationship: text(100),
        p_tone: text(300),
        p_prompt: required(2000, 'Prompt'),
        p_aspect_ratio: z.enum(['9:16', '1:1', '16:9', '']).nullish(),
        p_hook_style: text(50),
        p_call_to_action: text(200),
        p_reference_image_url: promoUrl(deps, who.userId),
        p_details: details,
      })
      .strict(),
    args,
  );

  const celeb = await orderableCelebrity(deps.db, a.p_celebrity_id);
  const base =
    a.p_order_type === 'video_wish'
      ? celebrityPricePaise(celeb, 'general_wish')
      : celebrityPricePaise(celeb, 'ugc_ad') || (await settingPricePaise(deps.db, 'ugc_video_price').catch(() => 0));
  if (base <= 0) throw new AppError(400, 'P0001', 'This service is not available for the selected celebrity');
  const price = await priceForUser(deps.db, who.profileId, base);

  return (await deps.db.begin(async (tx) => {
    const order = await insertRow(tx, deps.schema, 'wish_friend_orders', {
      user_id: who.profileId,
      order_type: a.p_order_type,
      celebrity_id: celeb.id,
      recipient_name: a.p_recipient_name,
      occasion: a.p_occasion,
      relationship: nullIfEmpty(a.p_relationship),
      tone: nullIfEmpty(a.p_tone),
      prompt: a.p_prompt,
      aspect_ratio: a.p_aspect_ratio || null,
      hook_style: nullIfEmpty(a.p_hook_style),
      call_to_action: nullIfEmpty(a.p_call_to_action),
      reference_image_url: nullIfEmpty(a.p_reference_image_url),
      order_details: a.p_details,
      original_price: rupees(base),
      discount_amount: Math.max(rupees(base) - rupees(price), 0),
      price_paid: rupees(price),
    });
    await chargeWallet(tx, deps, {
      profileId: who.profileId,
      userId: who.userId,
      // The production RPC records these as 'booking' rows.
      kind: 'booking',
      serviceType: 'wish_friend_order',
      pricePaise: price,
      table: 'wish_friend_orders',
      rowId: String(order.id),
      description: a.p_order_type === 'video_wish' ? 'Wish a Friend: video wish' : 'UGC video',
      mirrorable: false,
      extraDetails: { wish_friend_order_id: order.id, order_type: a.p_order_type, celebrity_id: celeb.id },
    });
    return order;
  })) as Row;
}

function adminBrief(a: { p_product_name: string; p_product_description: string; p_product_image_url: string; p_prompt: string; p_hook_style: string; p_call_to_action: string }, ratio: string, celeb: CelebrityPricing | null): string {
  // Same brief the production RPC leaves for the team in admin_notes.
  return JSON.stringify(
    {
      product_name: a.p_product_name,
      product_description: a.p_product_description,
      product_image_url: a.p_product_image_url,
      prompt: a.p_prompt,
      hook_style: a.p_hook_style || 'question',
      call_to_action: a.p_call_to_action || 'Check the link!',
      aspect_ratio: ratio,
      suggested_avatar_id: celeb?.heygenAvatarId ?? DEFAULT_AVATAR_ID,
      suggested_voice_id: celeb?.heygenVoiceId ?? DEFAULT_VOICE_ID,
      celebrity_name: celeb?.name ?? null,
    },
    null,
    2,
  );
}

export async function createUgcAdOrder(deps: Deps, auth: AuthContext, identity: Identity, args: Record<string, unknown>): Promise<Row> {
  const who = await caller(deps, auth, identity, 'create_ugc_ad_order');
  const a = parseArgs(
    z
      .object({
        p_celebrity_id: z.string().uuid().nullish(),
        p_product_name: required(200, 'Product name'),
        p_product_description: text(2000),
        p_product_image_url: promoUrl(deps, who.userId).pipe(z.string().min(1, 'Product name and at least one product image are required')),
        p_prompt: text(2000),
        p_hook_style: text(50),
        p_call_to_action: text(200),
        p_aspect_ratio: z.enum(['9:16', '1:1', '16:9', '']).nullish(),
        p_details: details,
      })
      .strict(),
    args,
  );
  const ratio = a.p_aspect_ratio || '9:16';
  const celeb = a.p_celebrity_id ? await orderableCelebrity(deps.db, a.p_celebrity_id) : null;
  const base = (celeb ? celebrityPricePaise(celeb, 'ugc_ad') : 0) || (await settingPricePaise(deps.db, 'ugc_ads_price').catch(() => 0));
  if (base <= 0) throw new AppError(400, 'P0001', 'UGC Ads are not available right now');
  const price = await priceForUser(deps.db, who.profileId, base);

  return (await deps.db.begin(async (tx) => {
    const order = await insertRow(tx, deps.schema, 'ugc_ads', {
      user_id: who.userId,
      product_name: a.p_product_name,
      product_description: nullIfEmpty(a.p_product_description),
      product_image_url: a.p_product_image_url,
      prompt: nullIfEmpty(a.p_prompt),
      hook_style: nullIfEmpty(a.p_hook_style),
      call_to_action: nullIfEmpty(a.p_call_to_action),
      aspect_ratio: ratio,
      celebrity_id: celeb?.id ?? null,
      status: 'pending_approval',
      price_paid: rupees(price),
      order_details: a.p_details,
      admin_notes: adminBrief(a, ratio, celeb),
    });
    await chargeWallet(tx, deps, {
      profileId: who.profileId,
      userId: who.userId,
      // The production RPC records UGC ads as 'ugc_video' rows.
      kind: 'ugc_video',
      serviceType: 'ugc_ad',
      pricePaise: price,
      table: 'ugc_ads',
      rowId: String(order.id),
      description: `UGC Ad: ${a.p_product_name}`.slice(0, 200),
      mirrorable: false,
      extraDetails: { ugc_ad_id: order.id, celebrity_id: celeb?.id ?? null },
    });
    return order;
  })) as Row;
}
