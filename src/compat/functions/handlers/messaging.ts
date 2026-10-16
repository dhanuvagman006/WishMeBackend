/**
 * Edge-function replacements for the messaging domain. See ../registry.ts for the conventions. Behaviour and response
 * shapes follow the deployed function source (Supabase audit export, 16 Oct 2026), without its holes: those functions
 * ran with the service role and trusted every id, recipient and text in the body.
 *
 *  send-whatsapp-welcome              welcome template to the caller's own phone, queued (not deployed in production)
 *  trigger-message-event              records the event and queues its notification (signup_complete → welcome email)
 *  send-celebrity-subscription-email  "new subscriber" email + celebrity_notifications row, for a real subscription
 *  send-wish-to-celebrity             posts a paid AI-card order into the user↔celebrity DM, plus the thank-you
 *  send-wish-thankyou-dm              the celebrity's thank-you DM for an uploaded card / video order
 *  celebrity-conversation-auto-reply  AI reply in a fan's conversation when the celebrity enabled auto-reply
 *  celebrity-ai-message               the dashboard's "AI Reply" for the celebrity's own conversation
 *  generate-occasion-auto-reply       AI reply stored on the caller's occasion wish
 *
 * Every id in a body is only a lookup key: ownership is checked against the caller's identity from the token, and
 * recipients, phone numbers, names, prices and card URLs are read from the database, never taken from the body.
 */
import { z } from 'zod';
import type { Identity } from '../../../auth/context.js';
import { insertRow, updateRows } from '../../../domains/accounts/rows.js';
import { e164India } from '../../../domains/accounts/phone.js';
import { findOrCreateConversation, loadConversation, postMessage, recentMessages } from '../../../domains/messaging/conversations.js';
import { newSubscriberEmail, welcomeEmail } from '../../../domains/messaging/emails.js';
import { chatReply, thankYouReply, type CelebrityPersona } from '../../../domains/messaging/replies.js';
import type { Deps } from '../../../deps.js';
import type { Queryable } from '../../../lib/db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../../lib/errors.js';
import { sql } from '../../../lib/sql.js';
import { welcomeTemplate, WhatsApp } from '../../../vendors/whatsapp.js';
import { defineFunctions, parseBody, type FnContext } from '../registry.js';

const uuid = z.string().uuid();
/** B2 public base for relative card keys (the app resolves relative image URLs against the same base). */
const B2_DEFAULT_PUBLIC_BASE = 'https://f005.backblazeb2.com/file/wishmetoday';

async function me(c: FnContext): Promise<{ userId: string; profileId: string; identity: Identity }> {
  const identity = await c.identity();
  if (!c.auth.userId || !identity.profileId) throw forbidden('A profile is required');
  return { userId: c.auth.userId, profileId: identity.profileId, identity };
}

interface CelebrityRow extends CelebrityPersona {
  id: string;
  profile_id: string | null;
}

async function celebrity(q: Queryable, id: string): Promise<CelebrityRow | null> {
  const rows = await q<{ j: CelebrityRow }[]>`select to_jsonb(c) as j from public.celebrities c where c.id = ${id}`;
  return rows[0]?.j ?? null;
}

interface ProfileBasics {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  user_id: string | null;
}

async function profileBasics(q: Queryable, profileId: string): Promise<ProfileBasics | null> {
  const rows = await q<ProfileBasics[]>`select first_name, last_name, email, phone, user_id::text from public.profiles where id = ${profileId}`;
  return rows[0] ?? null;
}

const fullName = (p: ProfileBasics | null) => [p?.first_name, p?.last_name].filter((s) => s && s.trim()).join(' ').trim() || null;

function absoluteUrl(deps: Deps, url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const base = (deps.env.B2_PUBLIC_BASE ?? B2_DEFAULT_PUBLIC_BASE).replace(/\/$/, '');
  return `${base}/${url.replace(/^\//, '')}`;
}

/** Pushes "you have a message" to the celebrity's own account (best effort). */
async function notifyCelebrity(deps: Deps, celeb: CelebrityRow, jobId: string, body: string): Promise<void> {
  if (!celeb.profile_id) return;
  const owner = await profileBasics(deps.db, celeb.profile_id);
  if (!owner?.user_id) return;
  await deps.jobs
    .enqueue('notifications', 'push', { userId: owner.user_id, title: 'New message on WishMe', body, data: { type: 'message' } }, { jobId })
    .catch((e: unknown) => deps.log.warn({ err: (e as Error).message }, 'push enqueue failed'));
}

// ── wish orders → DM ─────────────────────────────────────────────────────────────────────────────────────────

/** wish_celebrity_orders columns used here (production schema; it has no conversation_id column). */
interface WishOrder {
  id: string;
  user_id: string;
  celebrity_id: string;
  occasion_type: string | null;
  recipient_name: string | null;
  payment_status: string | null;
  status: string | null;
  card_approved: boolean | null;
  card_generation_type: string | null;
  card_url: string | null;
  generated_card_image_url: string | null;
  greeting_text: string | null;
  conversation_id?: string | null;
}

const OrderBody = z.object({ orderId: uuid }).passthrough();

/**
 * The caller's own, paid order. Production did not check either (any orderId worked, paid or not).
 * Locked FOR UPDATE when called inside a transaction.
 */
async function ownPaidOrder(q: Queryable, orderId: string, profileId: string): Promise<WishOrder> {
  const rows = await q<{ j: WishOrder }[]>`select to_jsonb(o) as j from public.wish_celebrity_orders o where o.id = ${orderId} for update`;
  const order = rows[0]?.j;
  if (!order || order.user_id !== profileId) throw notFound('Order not found');
  if (order.payment_status !== 'completed') throw conflict('This order has not been paid yet', 'order_not_paid');
  return order;
}

async function existingConversation(q: Queryable, userProfileId: string, celebrityId: string): Promise<string | null> {
  const rows = await q<{ id: string }[]>`
    select id::text from public.conversations where user_id = ${userProfileId} and celebrity_id = ${celebrityId} limit 1`;
  return rows[0]?.id ?? null;
}

/** Production's fixed thank-you texts (send-wish-to-celebrity and send-wish-thankyou-dm). */
const CARD_THANK_YOU =
  'Thank you so much for your wonderful wishes on my special day! 🎉 Your thoughtful greeting card truly made my day even more special. I appreciate you taking the time to celebrate with me! ❤️';

function uploadThankYou(order: WishOrder, wishmePaymentId: string | null): string {
  const what = order.card_generation_type === 'upload-video' ? 'video' : 'card';
  return `Thank you so much for your wonderful ${order.occasion_type ?? ''} wish! Your ${what} has been received and it truly warmed my heart. I appreciate you thinking of ${order.recipient_name || 'me'}. Stay blessed! 🌟💝${wishmePaymentId ? `\nPayment ID: ${wishmePaymentId}` : ''}`.replace(/  +/g, ' ');
}

// ── functions ────────────────────────────────────────────────────────────────────────────────────────────────

export const functions = defineFunctions([
  {
    name: 'send-whatsapp-welcome',
    // Not deployed in production (the app's call always failed silently). The app calls it right after sign-up with the
    // new session's token; our /auth/v1/signup always returns one. Anonymous calls are refused: they would let anyone
    // message arbitrary numbers at our expense.
    access: 'user',
    rateLimit: { limit: 3, windowSec: 3600, by: 'user' },
    handler: async (c) => {
      parseBody(z.object({ phone: z.string().max(20).optional(), name: z.string().max(100).optional() }), c.body);
      const { userId, profileId } = await me(c);
      const wa = c.deps.memo('whatsapp', () => new WhatsApp(c.deps.env, c.deps.log));
      if (!wa.configured) return { body: { success: true, skipped: true } };
      // Only the caller's own number, never the one in the body. Production's handle_new_user does not copy the
      // sign-up phone to profiles, so the auth metadata is the usual source right after sign-up.
      const profile = await profileBasics(c.deps.db, profileId);
      const metaPhone = (await c.deps.users.findById(userId))?.raw_user_meta_data?.phone;
      const to = e164India(profile?.phone ?? metaPhone);
      if (!to) return { body: { success: true, skipped: true, reason: 'no_phone' } };
      if (!(await c.deps.kv.set(`wa-welcome:${userId}`, '1', 365 * 86_400, true))) {
        return { body: { success: true, skipped: true, reason: 'already_sent' } };
      }
      const tpl = welcomeTemplate(c.deps.env);
      await c.deps.jobs.enqueue(
        'notifications',
        'send-whatsapp',
        { to, template: tpl.name, language: tpl.language, params: [profile?.first_name?.trim() || 'there'] },
        { jobId: `wa-welcome:${userId}` },
      );
      return { body: { success: true, queued: true } };
    },
  },

  {
    name: 'trigger-message-event',
    access: 'user',
    rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
    handler: async (c) => {
      // The app sends `event`; production's function reads `event_key` (so the app's call never matched an event).
      // user_id, email and phone in the body are ignored: the event is about the caller.
      const b = parseBody(
        z.object({ event: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(), event_key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional() }).passthrough(),
        c.body,
      );
      const event = b.event ?? b.event_key;
      if (!event) throw badRequest('event is required');
      const { userId, profileId } = await me(c);
      await c.deps.db`
        insert into wishme.audit_log (actor, action, subject, ip, request_id, details)
        values (${`user:${userId}`}, 'message_event', ${event}, ${c.ip}, ${c.requestId}, ${c.deps.db.json({ event, profile_id: profileId })})`;
      // ASSUMPTION: production routes events through message_events + send-unified-message templates (not ported);
      // only signup_complete has a notification here.
      if (event !== 'signup_complete') return { body: { success: true, event, queued: false } };
      const email = (await c.deps.users.findById(userId))?.email ?? c.auth.email;
      if (!email) return { body: { success: true, event, queued: false } };
      const profile = await profileBasics(c.deps.db, profileId);
      await c.deps.jobs.enqueue('notifications', 'send-email', { to: email, ...welcomeEmail(profile?.first_name?.trim() || null) }, { jobId: `welcome-email:${userId}` });
      return { body: { success: true, event, queued: true } };
    },
  },

  {
    name: 'send-celebrity-subscription-email',
    access: 'user',
    rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
    handler: async (c) => {
      // subscriber_name, subscriber_email and price_paid in the body are ignored: they are read from the database.
      const { celebrity_id } = parseBody(z.object({ celebrity_id: uuid }).passthrough(), c.body);
      const { profileId } = await me(c);
      const favs = await c.deps.db<{ id: string; price_paid: number | null }[]>`
        select id::text, price_paid from public.celebrity_favorites
        where user_id = ${profileId} and celebrity_id = ${celebrity_id} and status = 'active'
        order by created_at desc limit 1`;
      const fav = favs[0];
      if (!fav) throw forbidden('No active subscription to this celebrity');
      const celeb = await celebrity(c.deps.db, celebrity_id);
      if (!celeb) throw notFound('Celebrity not found');
      const owner = celeb.profile_id ? await profileBasics(c.deps.db, celeb.profile_id) : null;
      if (!owner?.email) return { body: { success: false, message: 'Celebrity email not configured' } };
      const subscriber = fullName(await profileBasics(c.deps.db, profileId)) ?? 'A fan';
      const followers = await c.deps.db<{ n: number }[]>`
        select count(*)::int as n from public.celebrity_favorites where celebrity_id = ${celebrity_id} and status = 'active'`;
      const price = fav.price_paid !== null ? String(fav.price_paid) : null;
      await c.deps.jobs.enqueue(
        'notifications',
        'send-email',
        { to: owner.email, ...newSubscriberEmail(owner.first_name?.trim() || celeb.name, subscriber, price, followers[0]?.n ?? 0) },
        { jobId: `sub-email:${fav.id}` },
      );
      if (await c.deps.kv.set(`sub-notification:${fav.id}`, '1', 30 * 86_400, true)) {
        await insertRow(c.deps.db, c.deps.schema, 'celebrity_notifications', {
          celebrity_id,
          type: 'subscription',
          title: 'New Subscriber!',
          message: `${subscriber} has subscribed to your profile${price ? ` for ₹${price}` : ''}.`,
          is_read: false,
        });
      }
      return { body: { success: true, message: 'Email sent successfully' } };
    },
  },

  {
    name: 'send-wish-to-celebrity',
    access: 'user',
    rateLimit: { limit: 20, windowSec: 600, by: 'user' },
    handler: async (c) => {
      // cardUrl / greetingText in the body (accepted by production as a fallback) are ignored: only the stored card is sent.
      const { orderId } = parseBody(OrderBody, c.body);
      const { profileId } = await me(c);
      const deps = c.deps;
      const result = await deps.db.begin(async (tx) => {
        const order = await ownPaidOrder(tx, orderId, profileId);
        if (order.card_approved || order.status === 'sent') {
          // Production answers 400 "Card has already been sent"; a retry here gets the original result instead.
          const existing = await existingConversation(tx, profileId, order.celebrity_id);
          if (existing) return { conversationId: existing, posted: false, order };
        }
        const card = absoluteUrl(deps, order.generated_card_image_url ?? order.card_url);
        const greeting = order.greeting_text?.trim();
        if (!card || !greeting) throw badRequest('Card must be generated before sending', 'card_missing');
        const conversationId = await findOrCreateConversation(tx, deps.schema, profileId, order.celebrity_id);
        // is_ai_generated as in production: it also keeps the database's auto-reply trigger from firing on the card.
        await postMessage(tx, deps.schema, { conversationId, senderId: profileId, senderType: 'user', text: `${greeting}\n\n[Greeting Card: ${card}]`, aiGenerated: true });
        const celeb = await celebrity(tx, order.celebrity_id);
        // Production posted this with celebrities.id as sender_id; the dashboard identifies the celebrity by profile id.
        if (celeb?.profile_id) {
          await postMessage(tx, deps.schema, { conversationId, senderId: celeb.profile_id, senderType: 'celebrity', text: CARD_THANK_YOU, aiGenerated: true });
        }
        await updateRows(tx, deps.schema, 'wish_celebrity_orders', { id: orderId }, {
          status: 'sent',
          card_approved: true,
          conversation_id: conversationId,
          completed_at: sql`now()`,
        });
        return { conversationId, posted: true, order };
      });
      if (result.posted) {
        const celeb = await celebrity(deps.db, result.order.celebrity_id);
        if (celeb) await notifyCelebrity(deps, celeb, `wish-sent:${orderId}`, 'A fan sent you a wish');
      }
      return { body: { success: true, message: 'Greeting card sent successfully to celebrity', conversation_id: result.conversationId } };
    },
  },

  {
    name: 'send-wish-thankyou-dm',
    access: 'user',
    rateLimit: { limit: 20, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const { orderId } = parseBody(OrderBody, c.body);
      const { profileId } = await me(c);
      const deps = c.deps;
      const done = `thankyou-dm:${orderId}`;
      const result = await deps.db.begin(async (tx) => {
        const order = await ownPaidOrder(tx, orderId, profileId);
        // One thank-you per order, however often the app retries (the app PATCHes status 'sent' itself afterwards).
        if (!(await deps.kv.set(done, '1', 365 * 86_400, true))) {
          return { conversationId: await existingConversation(tx, profileId, order.celebrity_id), posted: false };
        }
        const celeb = await celebrity(tx, order.celebrity_id);
        if (!celeb?.profile_id) throw notFound('Celebrity not found');
        const pay = await tx<{ id: string }[]>`
          select wishme_payment_id as id from public.payment_transactions where wish_order_id = ${orderId} limit 1`;
        const conversationId = await findOrCreateConversation(tx, deps.schema, profileId, order.celebrity_id);
        await postMessage(tx, deps.schema, { conversationId, senderId: celeb.profile_id, senderType: 'celebrity', text: uploadThankYou(order, pay[0]?.id ?? null), aiGenerated: true });
        return { conversationId, posted: true };
      }).catch(async (e: unknown) => {
        await deps.kv.del(done);
        throw e;
      });
      return { body: { success: true, message: 'Thank you DM sent successfully', ...(result.conversationId ? { conversation_id: result.conversationId } : {}) } };
    },
  },

  {
    name: 'celebrity-conversation-auto-reply',
    access: 'user',
    rateLimit: { limit: 30, windowSec: 600, by: 'user' },
    handler: async (c) => {
      // userMessage / messageText / celebrityId in the body are ignored: the reply answers what is stored.
      const { conversationId } = parseBody(z.object({ conversationId: uuid }).passthrough(), c.body);
      const { profileId } = await me(c);
      const deps = c.deps;
      const conv = await loadConversation(deps.db, conversationId);
      if (!conv || conv.user_id !== profileId) throw notFound('Conversation not found');
      if (conv.is_closed) return { body: { skipped: true, reason: 'conversation_closed' } };
      // As in production: either settings flag switches auto-replies on.
      const settings = await deps.db<{ on: boolean }[]>`
        select (coalesce(ai_auto_reply_enabled, false) or coalesce(auto_reply_enabled, false)) as "on"
        from public.celebrity_settings where celebrity_id = ${conv.celebrity_id} limit 1`;
      if (!settings[0]?.on) return { body: { skipped: true, reason: 'ai_auto_reply_disabled' } };
      const celeb = await celebrity(deps.db, conv.celebrity_id!);
      if (!celeb?.profile_id) return { body: { skipped: true, reason: 'celebrity_profile_not_linked' } };
      const history = await recentMessages(deps.db, conversationId);
      const last = history[history.length - 1];
      if (!last || last.sender_type !== 'user') return { body: { skipped: true, reason: 'duplicate_reply_prevented' } };
      // One reply per fan message, however often the app calls.
      const once = `auto-reply:${last.id}`;
      if (!(await deps.kv.set(once, '1', 86_400, true))) return { body: { skipped: true, reason: 'duplicate_reply_prevented' } };
      try {
        const fan = await profileBasics(deps.db, profileId);
        const reply = await chatReply(deps, celeb, fan?.first_name ?? null, history, celeb.profile_id);
        await deps.db.begin((tx) => postMessage(tx, deps.schema, { conversationId, senderId: celeb.profile_id!, senderType: 'celebrity', text: reply, aiGenerated: true }));
        return { body: { success: true, reply } };
      } catch (e) {
        await deps.kv.del(once);
        throw e;
      }
    },
  },

  {
    name: 'celebrity-ai-message',
    access: 'user',
    rateLimit: { limit: 30, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const { conversationId } = parseBody(z.object({ conversationId: uuid, userMessage: z.string().max(4000).optional() }), c.body);
      const { profileId, identity } = await me(c);
      const deps = c.deps;
      const conv = await loadConversation(deps.db, conversationId);
      if (!conv?.celebrity_id || !identity.celebrityIds.includes(conv.celebrity_id)) throw notFound('Conversation not found');
      const celeb = await celebrity(deps.db, conv.celebrity_id);
      if (!celeb) throw notFound('Conversation not found');
      const history = await recentMessages(deps.db, conversationId);
      if (!history.some((m) => m.sender_type === 'user')) throw new AppError(400, 'nothing_to_answer', 'There is no fan message to reply to yet');
      const fan = conv.user_id ? await profileBasics(deps.db, conv.user_id) : null;
      // Production sends as celebrities.profile_id; for the owning celebrity that is the caller's own profile id.
      const reply = await chatReply(deps, celeb, fan?.first_name ?? null, history, profileId);
      const message = await deps.db.begin((tx) => postMessage(tx, deps.schema, { conversationId, senderId: profileId, senderType: 'celebrity', text: reply, aiGenerated: true }));
      return { body: { success: true, message, reply } };
    },
  },

  {
    name: 'generate-occasion-auto-reply',
    access: 'user',
    rateLimit: { limit: 20, windowSec: 600, by: 'user' },
    handler: async (c) => {
      // celebrity_id, occasion_name and user_message are read from the wish and its occasion, not from the body.
      const { wish_id } = parseBody(z.object({ wish_id: uuid }).passthrough(), c.body);
      const { profileId } = await me(c);
      const deps = c.deps;
      const wishes = await deps.db<{ user_id: string; celebrity_id: string; occasion_id: string; message: string; reply_message: string | null }[]>`
        select user_id::text, celebrity_id::text, occasion_id::text, message, reply_message from public.occasion_wishes where id = ${wish_id}`;
      const wish = wishes[0];
      if (!wish || wish.user_id !== profileId) throw notFound('Wish not found');
      const done = { message: 'Auto-reply generated and sent successfully' };
      if (wish.reply_message) return { body: { reply: wish.reply_message, ...done } };
      const occs = await deps.db<{ celebrity_id: string; occasion_name: string; auto_reply_enabled: boolean }[]>`
        select celebrity_id::text, occasion_name, auto_reply_enabled from public.celebrity_occasions where id = ${wish.occasion_id}`;
      const occ = occs[0];
      // The app only calls when auto_reply_enabled; production did not re-check, which let anyone spend AI credit.
      if (!occ?.auto_reply_enabled) return { body: { skipped: true, reason: 'auto_reply_disabled' } };
      const celeb = await celebrity(deps.db, occ.celebrity_id);
      if (!celeb) throw notFound('Celebrity not found');
      const fan = await profileBasics(deps.db, profileId);
      const reply = await thankYouReply(deps, celeb, fan?.first_name ?? null, occ.occasion_name, wish.message);
      const updated = await deps.db<{ reply_message: string }[]>`
        update public.occasion_wishes set reply_message = ${reply}, reply_sent_at = now()
        where id = ${wish_id} and reply_message is null returning reply_message`;
      return { body: { reply: updated[0]?.reply_message ?? reply, ...done } };
    },
  },
]);
