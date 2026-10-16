/**
 * Edge-function replacements for the content-ai domain. See ../registry.ts for the conventions.
 *
 * Request and response shapes follow the app (docs/reference/BACKEND_CONTRACT_INVENTORY.md) and the deployed functions
 * (audit export, 16 Oct 2026). What changed on purpose: every paid function prices on the server (platform_settings +
 * the plan discount the app shows), debits through the ledger BEFORE calling the model and refunds on failure; ids
 * come from the token; reference images are read only from our own storage; everything is rate limited.
 */
import { z } from 'zod';
import type { Deps } from '../../../deps.js';
import { AppError, badRequest, forbidden, notFound, unavailable } from '../../../lib/errors.js';
import { sql } from '../../../lib/sql.js';
import {
  cleanSpokenText,
  enqueueGreetingCard,
  enqueueImagePromotion,
  enqueueWishCard,
  failAndRefund,
  failureMessage,
  generationTiming,
  heygenOf,
  occasionGreeting,
  occasionVideoScript,
  renderPhotoWish,
  waitForRow,
  WISH_CARD_LOCK_SEC,
  wishCardLockKey,
} from '../../../domains/content/generation.js';
import { assertAiReady, assertStorageReady, celebrityImageUrl, geminiOf, imageFromDataUri, storeUpload } from '../../../domains/content/media.js';
import { chargeWallet, newWishmePaymentId, orderableCelebrity, planDiscount, rupees, settingPriceForUser } from '../../../domains/content/money.js';
import { pushToProfile } from '../../../domains/messaging/push.js';
import { insertRow, selectRow, updateRow, UUID_RE, type Row } from '../../../domains/content/rows.js';
import { isPaid, loadOwnOrder } from '../../../domains/content/wish-orders.js';
import { defineFunctions, parseBody, type FnContext } from '../registry.js';

const IMAGE_BODY_LIMIT = 12 * 1024 * 1024;

async function profileOf(c: FnContext): Promise<{ userId: string; profileId: string }> {
  const identity = await c.identity();
  if (!c.auth.userId || !identity.profileId) throw notFound('Profile not found');
  return { userId: c.auth.userId, profileId: identity.profileId };
}

const name = (max: number) => z.string().trim().max(max);
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The words the deployed card functions refused; kept so the same messages are refused here. */
const PROFANITY = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy', 'cock', 'whore', 'slut', 'nigger', 'nigga', 'fag', 'faggot', 'retard', 'rape', 'kill', 'murder'];
function assertClean(...texts: Array<string | null | undefined>): void {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  if (PROFANITY.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(t))) throw badRequest('Your message contains inappropriate content. Please revise.', 'inappropriate_content');
}

/** The app's camelCase / snake_case pairs for the same three values. */
const wishContext = z
  .object({
    celebrityName: name(100).optional(),
    celebrity_name: name(100).optional(),
    occasionType: name(100).optional(),
    occasion: name(100).optional(),
    recipientName: name(100).optional(),
    recipient_name: name(100).optional(),
    message: z.string().max(2000).optional(),
  })
  .transform((b) => ({
    celebrity: b.celebrityName || b.celebrity_name || '',
    occasion: b.occasionType || b.occasion || '',
    recipient: b.recipientName || b.recipient_name || '',
    message: b.message ?? '',
  }));

const STRING_LIST = { type: 'ARRAY', items: { type: 'STRING' } };

function stringList(v: unknown, min: number): string[] {
  return (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x.length >= min);
}

/** Answers the wish-card request from the order row (the app reads the first non-null of several URL aliases). */
function cardResponse(order: Row, status?: string): Record<string, unknown> {
  const url = (order.generated_card_image_url as string | null) ?? null;
  return {
    success: true,
    ...(status ? { status } : {}),
    card_url: url,
    card_image_url: url,
    image_url: url,
    greeting_text: (order.greeting_text as string | null) ?? null,
    generation_attempts: Number(order.generation_attempts ?? 0),
  };
}

async function waitForLock(deps: Deps, key: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await deps.kv.get(key))) return true;
    await new Promise((r) => setTimeout(r, generationTiming.pollMs));
  }
  return !(await deps.kv.get(key));
}

const FALLBACK_LANGUAGES = [
  'Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'English', 'Filipino', 'Finnish', 'French',
  'German', 'Greek', 'Gujarati', 'Hindi', 'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Malay', 'Malayalam', 'Marathi',
  'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Slovak', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish',
  'Ukrainian', 'Urdu', 'Vietnamese',
];

const DOC_KINDS = ['report', 'letter', 'notes', 'plan', 'spreadsheet'] as const;
const DOC_LENGTHS: Record<string, string> = {
  short: 'about 300 words in total - 3 or 4 short sections',
  medium: 'about 800 words in total - 5 or 6 sections',
  long: 'about 1800 words in total - 8 to 10 sections, with real depth in each',
};
const PROSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    subtitle: { type: 'STRING' },
    sections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          heading: { type: 'STRING' },
          body: { type: 'STRING', description: 'Markdown. Paragraphs, - bullets, and **bold** only. No tables, no images, no code fences.' },
        },
        required: ['heading', 'body'],
      },
    },
  },
  required: ['title', 'sections'],
};
const SHEET_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    sheet: {
      type: 'OBJECT',
      properties: {
        columns: { type: 'ARRAY', items: { type: 'STRING' } },
        rows: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'STRING' } } },
        notes: { type: 'STRING', description: 'One short line explaining the figures, if any need it.' },
      },
      required: ['columns', 'rows'],
    },
  },
  required: ['title', 'sheet'],
};

function documentInstructions(kind: string, topic: string, audience: string, length: string, language: string): string {
  const shared =
    `Write in ${language}. Be accurate and concrete. Never invent statistics, prices, dates or quotations - if a figure is genuinely needed ` +
    'and you do not know it, describe what it depends on instead of inventing a number. Do not pad, and do not write a preamble about what you are about to write.';
  if (kind === 'spreadsheet') {
    return `Build a spreadsheet about: ${topic}\n${audience ? `It is for: ${audience}.\n` : ''}Choose columns that genuinely suit the subject, and fill in rows ` +
      `that are useful to someone working with it. Keep every cell short - a value or a few words, never a paragraph. Put any explanation in notes.\n${shared}`;
  }
  const shape: Record<string, string> = {
    report: 'a clear report: an opening that states what this is about, then sections that each make a point and support it, then a short conclusion',
    letter: 'a letter: a greeting, the body in a few short paragraphs, and a sign-off. Use sections for the paragraphs and keep headings empty strings.',
    notes: 'tidy notes: short sections, mostly bullet points, easy to skim',
    plan: 'a practical plan: the goal, the steps in order, what is needed, and the risks',
  };
  return `Write ${shape[kind]} on: ${topic}\n${audience ? `It is for: ${audience}.\n` : ''}Length: ${DOC_LENGTHS[length] ?? DOC_LENGTHS.medium}.\n${shared}`;
}

export const functions = defineFunctions([
  // ── text helpers ─────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: 'generate-message-suggestions',
    access: 'user',
    rateLimit: { limit: 20, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const b = parseBody(wishContext, c.body);
      if (!b.celebrity || !b.occasion) throw badRequest('Celebrity name and occasion type are required');
      const fan = b.recipient || 'a fan';
      const out = await geminiOf(c.deps).json<unknown>({
        prompt:
          `Generate 3 heartfelt, personal message suggestions for wishing ${b.celebrity} on their ${b.occasion}.\n\n` +
          `The messages are from a fan named ${fan} to the celebrity.\n\nRequirements:\n- Each message should be 2-3 sentences\n` +
          '- Make them warm, genuine, and specific to the occasion\n- Vary the tone: one formal, one casual, one emotional\n' +
          '- Keep them appropriate for a fan-to-celebrity context\n- Each should be unique and meaningful\n\nReturn ONLY a JSON array of 3 strings.',
        schema: STRING_LIST,
        maxTokens: 800,
        timeoutMs: 15_000,
      });
      return { body: { suggestions: stringList(out, 20).slice(0, 3) } };
    },
  },
  {
    name: 'suggest-greeting-card-prompts',
    access: 'user',
    rateLimit: { limit: 20, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const b = parseBody(wishContext, c.body);
      if (!b.celebrity || !b.occasion) throw badRequest('Celebrity name and occasion type are required');
      const out = await geminiOf(c.deps)
        .json<unknown>({
          system:
            'You are a creative AI assistant that generates beautiful, visually descriptive prompts for greeting card images. Your prompts should be ' +
            `vivid and detailed visual descriptions, appropriate for ${b.occasion} occasions, featuring or honoring ${b.celebrity}, warm, celebratory, ` +
            'visually rich, safe for all audiences, between 50-100 words each. Return ONLY a JSON array of 3 unique prompts as strings.',
          prompt:
            `Generate 3 creative, visually descriptive prompts for ${b.occasion} greeting card images featuring ${b.celebrity}` +
            `${b.recipient ? ` for ${b.recipient}` : ''}${b.message ? `. Context: ${b.message.slice(0, 100)}` : ''}.`,
          schema: STRING_LIST,
          maxTokens: 900,
          timeoutMs: 15_000,
        })
        .catch((e: unknown) => {
          if (e instanceof AppError && e.status === 503) throw e;
          return [];
        });
      let prompts = stringList(out, 20);
      if (prompts.length === 0) {
        prompts = [
          `A beautiful ${b.occasion} celebration scene featuring ${b.celebrity}, with vibrant colors, festive decorations, and warm lighting creating a joyful atmosphere`,
          `An elegant greeting card design for ${b.occasion} with ${b.celebrity}'s signature style, incorporating celebratory elements and heartfelt wishes`,
          `A stunning visual tribute for ${b.occasion} showcasing ${b.celebrity} in a warm, celebratory setting with artistic flourishes and festive charm`,
        ];
      }
      return { body: { prompts: prompts.slice(0, 3) } };
    },
  },
  {
    name: 'generate-script',
    access: 'anon',
    rateLimit: { limit: 10, windowSec: 600, by: 'user' },
    bodyLimit: 64 * 1024,
    handler: async (c) => {
      const b = parseBody(
        z.object({
          prompt: z.string().max(12_000).optional(),
          context: z.union([z.string().max(12_000), z.record(z.unknown())]).optional(),
          celebrityName: z.string().max(100).optional(),
          serviceType: z.string().max(50).optional(),
          talkingPoints: z.string().max(4000).optional(),
          requestDetails: z.record(z.unknown()).optional(),
          creativeGuidelines: z.record(z.unknown()).optional(),
        }),
        c.body,
      );
      let request = b.prompt?.trim() ?? '';
      if (!request && (b.context || b.requestDetails || b.celebrityName)) {
        const ctx = typeof b.context === 'string' ? b.context : JSON.stringify(b.context ?? b.requestDetails ?? {});
        request =
          `Generate a ${clean(b.serviceType, 50) || 'video'} script for ${clean(b.celebrityName, 100) || 'the celebrity'}.\n` +
          `Talking points: ${clean(b.talkingPoints, 4000)}\nRequest details: ${ctx.slice(0, 6000)}\n` +
          `Creative guidelines: ${JSON.stringify(b.creativeGuidelines ?? {}).slice(0, 2000)}`;
      }
      if (!request) throw badRequest('Either prompt or context is required');
      const out = await geminiOf(c.deps).text({
        system:
          'You are a professional script writer for personalized celebrity video messages. Output ONLY the spoken script text: no headers, labels, ' +
          'stage directions, notes or quotation marks. Every word will be spoken, so write naturally, as if the celebrity speaks directly to the recipient.',
        prompt: request,
        maxTokens: 700,
        temperature: 0.7,
        timeoutMs: 25_000,
      });
      return { body: { script: cleanSpokenText(out.text) } };
    },
  },
  {
    name: 'heygen-get-languages',
    access: 'anon',
    methods: ['GET', 'POST'],
    rateLimit: { limit: 30, windowSec: 600, by: 'ip' },
    handler: async (c) => {
      // The app expects an array of names (or {name}); the deployed function returned {languages:[...]}, which the app
      // could not read and so always used its own fallback list.
      const key = 'content:heygen-languages';
      const cached = await c.deps.kv.get(key);
      if (cached) return { body: JSON.parse(cached) as string[] };
      const heygen = heygenOf(c.deps);
      if (!heygen.configured) return { body: FALLBACK_LANGUAGES };
      const list = await heygen.voiceLanguages().catch((e: unknown) => {
        c.log.warn({ err: (e as Error).message }, 'heygen languages failed');
        return [] as string[];
      });
      const result = list.length > 5 ? list : FALLBACK_LANGUAGES;
      if (list.length > 5) await c.deps.kv.set(key, JSON.stringify(result), 24 * 3600);
      return { body: result };
    },
  },
  {
    name: 'generate-document',
    access: 'user',
    rateLimit: { limit: 10, windowSec: 600, by: 'user' },
    bodyLimit: 32 * 1024,
    handler: async (c) => {
      await c.deps.limiter.hit('fn:generate-document:day', `u:${c.auth.userId}`, { limit: 40, windowSec: 86_400 });
      const b = (c.body && typeof c.body === 'object' ? c.body : {}) as Record<string, unknown>;
      const topic = clean(b.topic, 1000);
      if (topic.length < 3) throw badRequest('Please say what the document should be about.');
      const kind = (DOC_KINDS as readonly string[]).includes(String(b.kind)) ? String(b.kind) : 'report';
      const length = ['short', 'medium', 'long'].includes(String(b.length)) ? String(b.length) : 'medium';
      const language = clean(b.language, 40) || 'English';
      const gemini = geminiOf(c.deps);
      if (!gemini.configured) throw unavailable('Document writing is not set up yet.');
      let doc: { title?: unknown; subtitle?: unknown; sections?: unknown; sheet?: unknown };
      try {
        doc = await gemini.json({
          prompt: documentInstructions(kind, topic, clean(b.audience, 200), length, language),
          schema: kind === 'spreadsheet' ? SHEET_SCHEMA : PROSE_SCHEMA,
          temperature: 0.6,
          maxTokens: length === 'long' ? 8192 : 4096,
          timeoutMs: 70_000,
        });
      } catch (e) {
        if (e instanceof AppError && e.status === 422) throw e;
        c.log.warn({ err: (e as Error).message }, 'generate-document failed');
        throw unavailable('The writing service is busy at the moment. Please try again in a minute.');
      }
      const title = clean(b.title, 150) || clean(doc.title, 150) || topic.slice(0, 80);
      return {
        body: {
          ok: true,
          kind,
          title,
          subtitle: clean(doc.subtitle, 200) || null,
          sections: Array.isArray(doc.sections) ? doc.sections : null,
          sheet: doc.sheet && typeof doc.sheet === 'object' ? doc.sheet : null,
          wordCount: JSON.stringify(doc).split(/\s+/).length,
        },
      };
    },
  },

  // ── wish-a-celebrity card (covered by the order's payment) ───────────────────────────────────────────────────
  {
    name: 'generate-wish-celebrity-card',
    access: 'user',
    rateLimit: { limit: 10, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const who = await profileOf(c);
      const { orderId } = parseBody(z.object({ orderId: z.string().uuid() }), c.body);
      const deps = c.deps;
      const order = await loadOwnOrder(deps.db, orderId, who.profileId);
      if (!order) throw notFound('Order not found');
      if (!isPaid(order)) throw forbidden('Payment for this order has not been received');
      if ((order.card_generation_type ?? 'ai') !== 'ai') throw badRequest('This order does not use an AI card');
      const full = (await selectRow(deps.db, deps.schema, 'wish_celebrity_orders', orderId))!;
      assertClean(full.message as string, full.recipient_name as string, full.card_prompt as string);
      assertAiReady(deps);
      assertStorageReady(deps);

      const lock = wishCardLockKey(orderId);
      const before = full.generated_card_image_url ?? null;
      if (await deps.kv.set(lock, '1', WISH_CARD_LOCK_SEC, true)) {
        const reserved = await deps.db<{ generation_attempts: number }[]>`
          update public.wish_celebrity_orders set generation_attempts = coalesce(generation_attempts, 0) + 1, updated_at = now()
          where id = ${orderId}::uuid and coalesce(generation_attempts, 0) < 3 returning generation_attempts`;
        if (!reserved[0]) {
          await deps.kv.del(lock);
          throw badRequest('Maximum regenerations reached (3)', 'max_attempts');
        }
        try {
          await enqueueWishCard(deps, orderId, reserved[0].generation_attempts);
        } catch (e) {
          await deps.db`update public.wish_celebrity_orders set generation_attempts = greatest(coalesce(generation_attempts, 0) - 1, 0) where id = ${orderId}::uuid`;
          await deps.kv.del(lock);
          c.log.error({ err: (e as Error).message, orderId }, 'wish card enqueue failed');
          throw unavailable('Card generation is temporarily unavailable. Please try again.');
        }
      }
      // A generation already running for this order is waited for, not started twice.
      const finished = await waitForLock(deps, lock, generationTiming.waitMs);
      const after = (await selectRow(deps.db, deps.schema, 'wish_celebrity_orders', orderId))!;
      if (!finished) return { body: cardResponse(after, 'processing') };
      if (!after.generated_card_image_url || after.generated_card_image_url === before) {
        throw new AppError(502, 'generation_failed', 'Card generation failed. Please try again.');
      }
      return { body: cardResponse(after) };
    },
  },

  // ── paid generations ─────────────────────────────────────────────────────────────────────────────────────────
  {
    name: 'generate-greeting-card-ai',
    access: 'user',
    bodyLimit: IMAGE_BODY_LIMIT,
    rateLimit: { limit: 10, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const who = await profileOf(c);
      const deps = c.deps;
      const b = parseBody(
        z.object({
          prompt: z.string().trim().min(1, 'Please describe the card').max(500),
          occasionName: name(80).pipe(z.string().min(1, 'is required')),
          recipientName: name(80).optional(),
          senderName: name(80).optional(),
          refinePrompt: z.boolean().optional(),
          referenceImageSource: z.enum(['upload', 'library', 'camera', 'none']).optional(),
          referenceImageUrl: z.string().max(IMAGE_BODY_LIMIT).nullish(),
        }),
        c.body,
      );
      assertAiReady(deps);
      assertStorageReady(deps);
      const source = b.referenceImageUrl ? (b.referenceImageSource ?? 'upload') : 'none';
      let referenceUrl: string | null = null;
      if (b.referenceImageUrl && (source === 'upload' || source === 'camera')) {
        referenceUrl = await storeUpload(deps, who.profileId, 'greeting-card-refs', imageFromDataUri(b.referenceImageUrl, 'referenceImageUrl'));
      } else if (b.referenceImageUrl && source === 'library') {
        // Only one of the caller's own generated cards can serve as a library reference.
        const own = await deps.db`select 1 from public.greeting_card_generations where user_id = ${who.profileId}::uuid and generated_image_url = ${b.referenceImageUrl} limit 1`;
        if (own.length === 0) throw badRequest('The reference card was not found in your library');
        referenceUrl = b.referenceImageUrl;
      }
      const discountPct = await planDiscount(deps.db, who.profileId);
      const price = await settingPriceForUser(deps.db, who.profileId, 'greeting_card_price');
      const wishmePaymentId = newWishmePaymentId();
      const row = (await deps.db.begin(async (tx) => {
        const r = await insertRow(tx, deps.schema, 'greeting_card_generations', {
          user_id: who.profileId,
          original_prompt: b.prompt,
          occasion_name: b.occasionName,
          recipient_name: b.recipientName ?? '',
          reference_image_url: referenceUrl,
          reference_image_source: source,
          prompt_refinement_used: b.refinePrompt ?? false,
          status: 'processing',
          amount_charged: rupees(price),
          wishme_payment_id: wishmePaymentId,
        });
        await chargeWallet(tx, deps, {
          profileId: who.profileId,
          userId: who.userId,
          kind: 'greeting_card_generation',
          serviceType: 'greeting_card_generation',
          pricePaise: price,
          table: 'greeting_card_generations',
          rowId: String(r.id),
          description: `Greeting card - ${b.occasionName}`.slice(0, 200),
          wishmePaymentId,
          extraDetails: { generation_id: r.id, occasion: b.occasionName, recipient: b.recipientName ?? '', discount_percentage: discountPct, final_price: rupees(price) },
        });
        return r;
      })) as Row;
      const id = String(row.id);
      try {
        await enqueueGreetingCard(deps, {
          id,
          prompt: b.prompt,
          occasion: b.occasionName,
          recipient: b.recipientName ?? '',
          sender: b.senderName ?? '',
          refine: b.refinePrompt ?? false,
          referenceUrl,
        });
      } catch (e) {
        await failAndRefund(deps, 'greeting_card_generations', id, ['processing'], { error_message: failureMessage(e) }, 'enqueue failed');
        throw unavailable('Card generation is temporarily unavailable. Your wallet has been refunded.');
      }
      const now = await waitForRow(deps, 'greeting_card_generations', id, (r) => r.status !== 'processing');
      if (now?.status === 'failed') throw new AppError(502, 'generation_failed', String(now.error_message ?? 'Generation failed'));
      return { body: { success: true, generation: now ?? row, discount_applied: discountPct, amount_charged: rupees(price) } };
    },
  },
  {
    name: 'generate-photo-wish',
    access: 'user',
    bodyLimit: IMAGE_BODY_LIMIT,
    rateLimit: { limit: 10, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const who = await profileOf(c);
      const deps = c.deps;
      const b = parseBody(
        z.object({
          originalImageBase64: z.string().min(1, 'Missing required fields').max(IMAGE_BODY_LIMIT),
          occasion: name(60).pipe(z.string().min(1, 'Missing required fields')),
          recipientName: name(80).pipe(z.string().min(1, 'Missing required fields')),
          wishMessage: z.string().trim().min(1, 'Missing required fields').max(500),
          senderName: name(80).nullish(),
          textStyle: z.enum(['elegant', 'playful', 'modern', 'classic', 'festive']).catch('elegant'),
        }),
        c.body,
      );
      const photo = imageFromDataUri(b.originalImageBase64, 'originalImageBase64');
      assertAiReady(deps);
      assertStorageReady(deps);
      // The app shows the plan-discounted price (usePlan().getDiscountedPrice); the user is charged what they saw.
      const price = await settingPriceForUser(deps.db, who.profileId, 'photo_wish_price');
      const wishmePaymentId = newWishmePaymentId();
      const row = (await deps.db.begin(async (tx) => {
        const r = await insertRow(tx, deps.schema, 'photo_wishes', {
          user_id: who.profileId,
          original_image_url: 'uploaded',
          edited_image_url: 'processing',
          occasion: b.occasion,
          recipient_name: b.recipientName,
          wish_message: b.wishMessage,
          sender_name: b.senderName || null,
          text_style: b.textStyle,
          amount_charged: rupees(price),
          status: 'processing',
        });
        await chargeWallet(tx, deps, {
          profileId: who.profileId,
          userId: who.userId,
          kind: 'photo_wish',
          serviceType: 'photo_wish',
          pricePaise: price,
          table: 'photo_wishes',
          rowId: String(r.id),
          description: `Photo Wish - ${b.occasion} for ${b.recipientName}`.slice(0, 200),
          wishmePaymentId,
          extraDetails: { photo_wish_id: r.id },
        });
        return r;
      })) as Row;
      const id = String(row.id);
      try {
        const url = await renderPhotoWish(deps, who.profileId, id, {
          photo,
          occasion: b.occasion,
          recipientName: b.recipientName,
          wishMessage: b.wishMessage,
          senderName: b.senderName || null,
          textStyle: b.textStyle,
        });
        await updateRow(deps.db, deps.schema, 'photo_wishes', id, { edited_image_url: url, status: 'completed', completed_at: new Date().toISOString() }, sql`t.status = 'processing'`);
        await pushToProfile(deps, {
          profileId: who.profileId,
          title: 'Your photo wish is ready',
          body: `Your ${b.occasion} photo wish for ${b.recipientName} is ready.`.slice(0, 500),
          data: { type: 'photo_wish_completed', id },
          jobId: `photo_wish_completed:${id}`,
        });
        return { body: { success: true, photoWishId: id, editedImageUrl: url, amountCharged: rupees(price), wishmePaymentId } };
      } catch (e) {
        c.log.warn({ id, err: (e as Error).message }, 'photo wish failed');
        await failAndRefund(deps, 'photo_wishes', id, ['processing'], { edited_image_url: null, error_message: failureMessage(e) }, (e as Error).message);
        throw new AppError(502, 'generation_failed', failureMessage(e));
      }
    },
  },
  {
    name: 'generate-image-promotion',
    access: 'user',
    bodyLimit: IMAGE_BODY_LIMIT,
    rateLimit: { limit: 10, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const who = await profileOf(c);
      const deps = c.deps;
      const b = parseBody(
        z.object({
          celebrityId: z.string().uuid(),
          concept: z.string().trim().min(1, 'Please describe the concept').max(500),
          brandingDetails: z.string().trim().max(300).nullish(),
          referenceImageSource: z.enum(['upload', 'none']).optional(),
          referenceImageUrl: z.string().max(IMAGE_BODY_LIMIT).nullish(),
        }),
        c.body,
      );
      const ref = b.referenceImageUrl && b.referenceImageSource !== 'none' ? imageFromDataUri(b.referenceImageUrl, 'referenceImageUrl') : null;
      const celeb = await orderableCelebrity(deps.db, b.celebrityId);
      // The screen only offers celebrities the user subscribes to (useCelebrityFavorites); enforced here as well.
      if (deps.schema.table('celebrity_favorites')) {
        const sub = await deps.db`select 1 from public.celebrity_favorites where user_id = ${who.profileId}::uuid and celebrity_id = ${celeb.id}::uuid and status = 'active' limit 1`;
        if (sub.length === 0) throw forbidden('Subscribe to this celebrity to create image promotions');
      }
      assertAiReady(deps);
      assertStorageReady(deps);
      const referenceUrl = ref ? await storeUpload(deps, who.profileId, 'promotion-refs', ref) : null;
      const price = await settingPriceForUser(deps.db, who.profileId, 'image_promotion_price');
      const row = (await deps.db.begin(async (tx) => {
        const r = await insertRow(tx, deps.schema, 'image_promotions', {
          user_id: who.profileId,
          celebrity_id: celeb.id,
          concept: b.concept,
          branding_details: b.brandingDetails || null,
          price_paid: rupees(price),
          status: 'pending',
        });
        await chargeWallet(tx, deps, {
          profileId: who.profileId,
          userId: who.userId,
          kind: 'image_promotion',
          serviceType: 'image_promotion',
          pricePaise: price,
          table: 'image_promotions',
          rowId: String(r.id),
          description: `AI Image Promotion - ${celeb.name}`.slice(0, 200),
          wishmePaymentId: newWishmePaymentId(),
          extraDetails: { image_promotion_id: r.id },
        });
        return r;
      })) as Row;
      const id = String(row.id);
      try {
        await enqueueImagePromotion(deps, { id, celebrityId: celeb.id, concept: b.concept, branding: b.brandingDetails ?? '', referenceUrl });
      } catch (e) {
        await failAndRefund(deps, 'image_promotions', id, ['pending'], { error_message: failureMessage(e) }, 'enqueue failed');
        throw unavailable('Image generation is temporarily unavailable. Your wallet has been refunded.');
      }
      const now = await waitForRow(deps, 'image_promotions', id, (r) => r.status !== 'pending');
      if (now?.status === 'failed') throw new AppError(502, 'generation_failed', String(now.error_message ?? 'Generation failed'));
      return { body: { success: true, generation: now ?? row } };
    },
  },

  // ── occasion bookings (free; the app fires these and does not read the answer) ───────────────────────────────
  {
    name: 'generate-greeting-card',
    access: 'user',
    rateLimit: { limit: 10, windowSec: 86_400, by: 'user' },
    handler: async (c) => occasionText(c, 'greeting_card'),
  },
  {
    name: 'generate-occasion-video',
    access: 'user',
    rateLimit: { limit: 10, windowSec: 86_400, by: 'user' },
    handler: async (c) => occasionText(c, 'video'),
  },
]);

/**
 * Both occasion functions write AI text onto the caller's own occasion booking, as deployed: the greeting card gets
 * ai_generated_content + greeting_card_url (the celebrity's photo) and status 'completed'; the video gets its spoken
 * script in ai_generated_content and status 'processing' (the video itself is made by the booking video pipeline).
 * A booking that already has its text is answered from the row, so repeated calls cost nothing.
 */
async function occasionText(c: FnContext, type: 'greeting_card' | 'video') {
  const who = await profileOf(c);
  const deps = c.deps;
  const b = parseBody(
    z.object({
      bookingId: z.string().regex(UUID_RE, 'Invalid bookingId'),
      occasionName: z.string().max(100).optional(),
      recipientName: z.string().max(100).optional(),
      message: z.string().max(2000).optional(),
      celebrityId: z.string().optional(),
    }),
    c.body,
  );
  const rows = await deps.db<{ id: string; booking_type: string; status: string | null; recipient_name: string; message: string; ai_generated_content: string | null; celebrity_id: string; occasion_id: string }[]>`
    select id::text, booking_type, status, recipient_name, message, ai_generated_content, celebrity_id::text, occasion_id::text
    from public.occasion_bookings where id = ${b.bookingId}::uuid and user_id = ${who.profileId}::uuid`;
  const booking = rows[0];
  if (!booking) throw notFound('Booking not found');
  if (booking.booking_type !== type) throw badRequest('This booking is of another type');
  const celeb = await deps.db<{ name: string; image_url: string | null }[]>`select name, image_url from public.celebrities where id = ${booking.celebrity_id}::uuid`;
  const imageUrl = celebrityImageUrl(celeb[0]?.image_url) ?? '';
  if (booking.ai_generated_content) {
    return { body: type === 'video' ? { success: true, script: booking.ai_generated_content } : { success: true, text: booking.ai_generated_content, imageUrl } };
  }
  assertAiReady(deps);
  // The booking row is the source of truth for names and message; the body only fills the occasion name.
  const occasion = await deps.db<{ name: string }[]>`select name from public.occasions where id = ${booking.occasion_id}::uuid`.catch(() => []);
  const input = {
    bookingId: booking.id,
    occasionName: occasion[0]?.name ?? clean(b.occasionName, 100),
    recipientName: booking.recipient_name,
    message: booking.message,
    celebrityName: celeb[0]?.name ?? '',
  };
  if (type === 'video') {
    const script = await occasionVideoScript(deps, input);
    await updateRow(deps.db, deps.schema, 'occasion_bookings', booking.id, { ai_generated_content: script, status: 'processing' });
    return { body: { success: true, script } };
  }
  const text = await occasionGreeting(deps, input);
  await updateRow(deps.db, deps.schema, 'occasion_bookings', booking.id, { ai_generated_content: text, greeting_card_url: imageUrl, status: 'completed' });
  return { body: { success: true, text, imageUrl } };
}
