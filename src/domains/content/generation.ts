/**
 * AI-generated content: greeting cards, image promotions, wish-celebrity cards, photo wishes and the occasion-booking
 * texts. The functions in content-ai.ts validate, price, charge and create the row; the work itself runs here, either
 * inline (photo wish: the app waits up to 120 s; occasion texts: fire-and-forget) or as a 'content' job whose result
 * the app sees by polling the row. Paid work is charged before the vendor is called and refunded when it fails.
 *
 * Prompts and row transitions follow the deployed edge functions (audit export, 16 Oct 2026); their vendor chain
 * (OpenRouter / Lovable gateway / Gemini) is replaced by the Gemini client, which was already their last fallback.
 */
import type { Deps } from '../../deps.js';
import { AppError } from '../../lib/errors.js';
import { sql } from '../../lib/sql.js';
import { QUEUES } from '../../jobs/queues.js';
import { pushToProfile } from '../messaging/push.js';
import type { InlineImage } from '../../vendors/gemini.js';
import { HeyGen } from '../../vendors/heygen.js';
import { celebrityImageUrl, fetchOwnImage, geminiOf, storeImage } from './media.js';
import { refundRow } from './money.js';
import { hasColumn, selectRow, updateRow, type Row } from './rows.js';

/** How long a function waits for its job before answering with the row as it stands (the app then polls). */
export const generationTiming = { waitMs: 15_000, pollMs: 750 };

export const CONTENT_JOBS = {
  greetingCard: 'greeting-card',
  imagePromotion: 'image-promotion',
  wishCard: 'wish-card',
  sweep: 'content-sweep',
} as const;

/** Vendor failures are handled (and refunded) by the processors; the second attempt only covers infrastructure blips. */
export const CONTENT_JOB_OPTS = { attempts: 2, backoff: { type: 'exponential', delay: 10_000 } } as const;

export const heygenOf = (deps: Deps): HeyGen => deps.memo('heygen', () => new HeyGen(deps.env, deps.log));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const s = (v: unknown, max = 500): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** A message safe to show the user for a failed generation (vendor details stay in the logs). */
export function failureMessage(e: unknown): string {
  if (e instanceof AppError && (e.status === 422 || e.code === 'no_image')) return e.message;
  return 'Generation failed. Any amount charged has been refunded to your wallet.';
}

export async function waitForRow(deps: Deps, table: string, id: string, done: (row: Row) => boolean, ms = generationTiming.waitMs): Promise<Row | null> {
  const deadline = Date.now() + ms;
  let row = await selectRow(deps.db, deps.schema, table, id);
  while (row && !done(row) && Date.now() < deadline) {
    await sleep(generationTiming.pollMs);
    row = await selectRow(deps.db, deps.schema, table, id);
  }
  return row;
}

/** Marks the row failed (only from one of the `from` statuses) and refunds its charge, in one transaction. */
export async function failAndRefund(deps: Deps, table: string, id: string, from: readonly string[], patch: Row, reason: string): Promise<boolean> {
  return (await deps.db.begin(async (tx) => {
    const row = await updateRow(tx, deps.schema, table, id, { status: 'failed', ...patch }, sql`t.status = any(string_to_array(${from.join(',')}, ','))`);
    if (!row) return false;
    await refundRow(tx, deps, table, id, reason);
    return true;
  })) as boolean;
}

async function enqueue(deps: Deps, name: string, jobId: string, data: Record<string, unknown>): Promise<void> {
  await deps.jobs.enqueue(QUEUES.content, name, data, { ...CONTENT_JOB_OPTS, jobId });
}

// ── greeting cards (generate-greeting-card-ai) ─────────────────────────────────────────────────────────────────

export interface GreetingCardJob {
  id: string;
  prompt: string;
  occasion: string;
  recipient: string;
  sender: string;
  refine: boolean;
  referenceUrl: string | null;
}

export const enqueueGreetingCard = (deps: Deps, job: GreetingCardJob) => enqueue(deps, CONTENT_JOBS.greetingCard, `greeting-card:${job.id}`, { ...job });

export async function runGreetingCard(deps: Deps, job: GreetingCardJob): Promise<Record<string, unknown>> {
  const table = 'greeting_card_generations';
  const row = await selectRow(deps.db, deps.schema, table, job.id);
  if (!row || row.status !== 'processing') return { skipped: true };
  try {
    const gemini = geminiOf(deps);
    const sender = s(job.sender, 80) || 'Your Friend';
    const occasion = s(job.occasion, 80);
    const recipient = s(job.recipient, 80);
    let style = s(job.prompt, 500);
    if (job.refine) {
      const refined = await gemini
        .text({
          system: 'Refine image generation prompts for greeting cards. Make prompts visually descriptive. Keep it to 2-3 sentences.',
          prompt: `Refine this greeting card prompt for ${occasion}:\n"${style}"`,
          maxTokens: 300,
          timeoutMs: 20_000,
        })
        .catch(() => null);
      if (refined?.text) {
        style = s(refined.text, 1200);
        await updateRow(deps.db, deps.schema, table, job.id, { refined_prompt: style });
      }
    }
    const ref = await fetchOwnImage(deps, job.referenceUrl);
    const imagePrompt = ref
      ? `Create a premium greeting card. Incorporate the provided reference photo as the main focal point.\n` +
        `Add text: "Happy ${occasion}, ${recipient}!" prominently.\nAdd: "With love from ${sender}" at the bottom.\n` +
        `Style: ${style}. Occasion: ${occasion}.`
      : `Generate a beautiful greeting card for ${occasion}.\nRecipient: ${recipient}. Sender: ${sender}.\nStyle: ${style}.\n` +
        `Include text: "Happy ${occasion}, ${recipient}!" prominently.\nInclude: "With love from ${sender}" at bottom.\n` +
        'Professional, warm colors, premium design. High quality.';
    const [image, text] = await Promise.all([
      gemini.image({ prompt: imagePrompt, ...(ref ? { images: [ref] } : {}), timeoutMs: 100_000 }),
      gemini
        .text({
          system: 'Write warm 2-3 sentence greeting card messages. Include sender name at end.',
          prompt: `Write a ${occasion} message for ${recipient} from ${sender}.`,
          maxTokens: 300,
          timeoutMs: 20_000,
        })
        .catch(() => null),
    ]);
    const stored = await storeImage(deps, String(row.user_id), 'greeting-cards', job.id, image);
    await updateRow(deps.db, deps.schema, table, job.id, {
      status: 'completed',
      generated_image_url: stored.url,
      greeting_text: s(text?.text, 1000) || `Dear ${recipient}, Wishing you a wonderful ${occasion}! With love, ${sender}`,
      error_message: null,
      completed_at: new Date().toISOString(),
    }, sql`t.status = 'processing'`);
    await pushToProfile(deps, {
      profileId: String(row.user_id),
      title: 'Your greeting card is ready',
      body: `Your ${occasion} card for ${recipient} is ready to view and share.`.slice(0, 500),
      data: { type: 'greeting_card_ready', id: job.id },
      jobId: `greeting_card_ready:${job.id}`,
    });
    return { completed: true };
  } catch (e) {
    deps.log.warn({ id: job.id, err: (e as Error).message }, 'greeting card generation failed');
    await failAndRefund(deps, table, job.id, ['processing'], { error_message: failureMessage(e) }, (e as Error).message);
    return { failed: true };
  }
}

// ── image promotions (generate-image-promotion) ────────────────────────────────────────────────────────────────

export interface ImagePromotionJob {
  id: string;
  celebrityId: string;
  concept: string;
  branding: string;
  referenceUrl: string | null;
}

export const enqueueImagePromotion = (deps: Deps, job: ImagePromotionJob) => enqueue(deps, CONTENT_JOBS.imagePromotion, `image-promotion:${job.id}`, { ...job });

const MAX_CELEBRITY_PHOTOS = 3;

/** Real photos of the celebrity, best first (profile, consent, promotional), as the deployed function used them. */
async function celebrityPhotos(deps: Deps, celebrityId: string): Promise<{ name: string; category: string; photos: InlineImage[] }> {
  const rows = await deps.db<{ name: string; category: string | null; image_url: string | null; consent_photo_url: string | null; promotional_image_url: string | null }[]>`
    select name, category, image_url, consent_photo_url, promotional_image_url from public.celebrities where id = ${celebrityId}::uuid`;
  const c = rows[0];
  const photos: InlineImage[] = [];
  for (const url of [celebrityImageUrl(c?.image_url), c?.consent_photo_url, c?.promotional_image_url]) {
    if (photos.length >= MAX_CELEBRITY_PHOTOS || !url) continue;
    const img = await fetchOwnImage(deps, url);
    if (img) photos.push(img);
  }
  return { name: c?.name ?? '', category: c?.category ?? '', photos };
}

export async function runImagePromotion(deps: Deps, job: ImagePromotionJob): Promise<Record<string, unknown>> {
  const table = 'image_promotions';
  const row = await selectRow(deps.db, deps.schema, table, job.id);
  if (!row || row.status !== 'pending') return { skipped: true };
  try {
    const celeb = await celebrityPhotos(deps, job.celebrityId);
    const ref = await fetchOwnImage(deps, job.referenceUrl);
    let prompt = `Create a professional promotional image featuring ${s(celeb.name, 80)} (${s(celeb.category, 60)}).\nConcept: ${s(job.concept, 500)}`;
    if (job.branding) prompt += `\nBranding: ${s(job.branding, 300)}`;
    prompt += '\nStyle: High-quality professional marketing image, vibrant colors, modern design.';
    if (celeb.photos.length > 0) {
      prompt +=
        `\n\nIMPORTANT: The attached photo(s) show the real ${s(celeb.name, 80)}. The person in the image MUST be this exact person: ` +
        'keep their real face, facial features, skin tone, hair and age recognisable and true to the photo(s). Do not invent, replace or ' +
        'alter the person, and do not use a lookalike. Only change the setting, clothing, lighting and layout to fit the concept.';
    }
    const images = [...celeb.photos, ...(ref ? [ref] : [])];
    const image = await geminiOf(deps).image({ prompt, ...(images.length ? { images } : {}), timeoutMs: 100_000 });
    const stored = await storeImage(deps, String(row.user_id), 'image-promotions', job.id, image);
    await updateRow(deps.db, deps.schema, table, job.id, {
      status: 'completed',
      generated_image_url: stored.url,
      error_message: null,
      completed_at: new Date().toISOString(),
    }, sql`t.status = 'pending'`);
    return { completed: true };
  } catch (e) {
    deps.log.warn({ id: job.id, err: (e as Error).message }, 'image promotion failed');
    await failAndRefund(deps, table, job.id, ['pending'], { error_message: failureMessage(e), completed_at: new Date().toISOString() }, (e as Error).message);
    return { failed: true };
  }
}

// ── wish-celebrity cards (generate-wish-celebrity-card; paid with the order) ───────────────────────────────────

export const wishCardLockKey = (orderId: string) => `content:wish-card:${orderId}`;
export const WISH_CARD_LOCK_SEC = 300;

export const enqueueWishCard = (deps: Deps, orderId: string, attempt: number) =>
  enqueue(deps, CONTENT_JOBS.wishCard, `wish-card:${orderId}:${attempt}`, { orderId, attempt });

/**
 * The card is a fan's greeting TO the celebrity ("Happy <occasion>, <celebrity>! ... From your fan, <recipient_name>"),
 * built around the celebrity's own photo. Success sets status 'generated' (the only post-payment status besides
 * 'sent' / 'failed' that the table allows).
 */
export async function runWishCard(deps: Deps, orderId: string): Promise<Record<string, unknown>> {
  try {
    const rows = await deps.db<
      { user_id: string; occasion_type: string | null; recipient_name: string | null; message: string | null; card_prompt: string | null; celeb_name: string | null; celeb_image: string | null; payment_status: string | null }[]
    >`
      select o.user_id::text, o.occasion_type, o.recipient_name, o.message, o.card_prompt, o.payment_status,
             c.name as celeb_name, c.image_url as celeb_image
      from public.wish_celebrity_orders o left join public.celebrities c on c.id = o.celebrity_id
      where o.id = ${orderId}::uuid`;
    const o = rows[0];
    if (!o || o.payment_status !== 'completed') return { skipped: true };
    const gemini = geminiOf(deps);
    const celeb = s(o.celeb_name, 80) || 'Celebrity';
    const occasion = s(o.occasion_type, 80);
    const fan = s(o.recipient_name, 80);
    const photo = await fetchOwnImage(deps, celebrityImageUrl(o.celeb_image));
    const base =
      `Create a greeting card for ${celeb}'s ${occasion}.\nMain text: "Happy ${occasion}, ${celeb}!" prominently.\n` +
      `Bottom: "From your fan, ${fan}" in smaller text.\nStyle: Celebratory, festive, ${occasion} theme. ${s(o.card_prompt, 600) || 'Elegant fan appreciation style'}.`;
    const [text, image] = await Promise.all([
      gemini
        .text({
          prompt:
            `Create a warm greeting from a fan to ${celeb} for ${occasion}.\nFan's message: ${s(o.message, 1000)}. Address ${celeb} by name. ` +
            `Express admiration. 2-3 sentences.\n${o.card_prompt ? `Style: ${s(o.card_prompt, 300)}` : ''}`,
          maxTokens: 300,
          timeoutMs: 15_000,
        })
        .catch(() => null),
      gemini.image({
        prompt: photo ? `${base}\nIncorporate this photo of ${celeb} prominently. Use the provided reference photo.` : base,
        ...(photo ? { images: [photo] } : {}),
        timeoutMs: 60_000,
      }),
    ]);
    const stored = await storeImage(deps, o.user_id, 'wish-cards', orderId, image);
    await updateRow(deps.db, deps.schema, 'wish_celebrity_orders', orderId, {
      greeting_text: s(text?.text, 1000) || `Happy ${occasion}, ${celeb}! ${s(o.message, 600)} From your fan, ${fan}.`,
      generated_card_image_url: stored.url,
      card_url: stored.url,
      status: 'generated',
    }, sql`t.status in ('pending', 'generated', 'failed')`);
    return { completed: true };
  } catch (e) {
    // A failed generation does not use up one of the order's three attempts.
    deps.log.warn({ orderId, err: (e as Error).message }, 'wish card generation failed');
    await deps.db`update public.wish_celebrity_orders set generation_attempts = greatest(coalesce(generation_attempts, 0) - 1, 0) where id = ${orderId}::uuid`;
    return { failed: true };
  } finally {
    await deps.kv.del(wishCardLockKey(orderId));
  }
}

// ── photo wishes (generate-photo-wish; inline) ─────────────────────────────────────────────────────────────────

export interface PhotoWishInput {
  photo: InlineImage;
  occasion: string;
  recipientName: string;
  wishMessage: string;
  senderName: string | null;
  textStyle: string;
}

const STYLE_INSTRUCTIONS: Record<string, string> = {
  elegant: 'Elegant cursive fonts with gold accents and floral decorations.',
  playful: 'Fun bouncy fonts with bright colors, confetti, and balloons.',
  modern: 'Clean sans-serif fonts with gradient colors and geometric elements.',
  classic: 'Traditional serif fonts with classic borders and ribbons.',
  festive: 'Celebratory fonts with glitter, sparkles, and lights.',
};

export async function renderPhotoWish(deps: Deps, profileId: string, id: string, input: PhotoWishInput): Promise<string> {
  const gemini = geminiOf(deps);
  const prompt =
    'Add a beautiful wish text overlay to this photo.\nKEEP EXACT DIMENSIONS. PRESERVE FULL PHOTO. Only ADD text on top.\n' +
    `Text: Occasion: ${s(input.occasion, 60)}. Recipient: "${s(input.recipientName, 80)}". Message: "${s(input.wishMessage, 500)}". ` +
    `${input.senderName ? `From: "${s(input.senderName, 80)}"` : ''}\n` +
    `Style: ${input.textStyle}. ${STYLE_INSTRUCTIONS[input.textStyle] ?? STYLE_INSTRUCTIONS.elegant}\n` +
    'Place text in empty areas, never cover faces. Use semi-transparent banners for readability.';
  const retry =
    `Add text overlay to this photo. Text: "${s(input.wishMessage, 500)}" for ${s(input.recipientName, 80)}. Occasion: ${s(input.occasion, 60)}. ` +
    `${input.senderName ? `From: ${s(input.senderName, 80)}. ` : ''}Use ${input.textStyle} style. Keep original image intact, only add text.`;
  let image: { mimeType: string; data: Buffer };
  try {
    image = await gemini.image({ prompt, images: [input.photo], timeoutMs: 55_000 });
  } catch (e) {
    // The deployed function retried once with a simpler prompt when the model returned no image.
    if (!(e instanceof AppError) || e.code !== 'no_image') throw e;
    image = await gemini.image({ prompt: retry, images: [input.photo], timeoutMs: 45_000 });
  }
  return (await storeImage(deps, profileId, 'photo-wishes', id, image)).url;
}

// ── occasion bookings (generate-greeting-card / generate-occasion-video; free, fire-and-forget) ────────────────

export interface OccasionInput {
  bookingId: string;
  occasionName: string;
  recipientName: string;
  message: string;
  celebrityName: string;
}

const LABEL_RE = /^(Script|Opening|Greeting|Message|Closing|Body|Intro|Outro|Note|Instructions?|Text|Card):\s*/gim;

/** Cleans model output that is spoken or printed verbatim (labels, markdown headers, stage directions, quotes). */
export function cleanSpokenText(text: string): string {
  return text
    .replace(LABEL_RE, '')
    .replace(/^\*\*.*?\*\*\s*/gm, '')
    .replace(/^#.*$/gm, '')
    .replace(/^\[.*?\]\s*/gm, '')
    .replace(/^\(.*?\)\s*/gm, '')
    .replace(/^[-•]\s*/gm, '')
    .replace(/"/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function occasionGreeting(deps: Deps, input: OccasionInput): Promise<string> {
  const { text } = await geminiOf(deps).text({
    system: 'You are a greeting card writer. Create a beautiful, concise greeting card message. Output ONLY the greeting text - no headers, no labels, no formatting.',
    prompt:
      `Context:\n- Celebrity: ${s(input.celebrityName, 80) || 'Celebrity'}\n- Occasion: ${s(input.occasionName, 80)}\n- Recipient: ${s(input.recipientName, 80)}\n` +
      `- User's message: ${s(input.message, 1000)}\n\nCreate a heartfelt 2-3 sentence greeting that celebrates the occasion, addresses the recipient warmly, ` +
      'incorporates the essence of the user\'s message and includes positive wishes.',
    maxTokens: 200,
    temperature: 0.8,
    timeoutMs: 25_000,
  });
  return cleanSpokenText(text).slice(0, 2000);
}

export async function occasionVideoScript(deps: Deps, input: OccasionInput): Promise<string> {
  const { text } = await geminiOf(deps).text({
    system:
      'You are a script writer for personalized celebrity video messages. Output ONLY the spoken script text: no headers, labels, ' +
      'stage directions, notes, quotation marks, bullet points or numbered lists. Every word will be spoken by a text-to-speech system.',
    prompt:
      `Create a warm, heartfelt 30-45 second video script for:\n- Celebrity: ${s(input.celebrityName, 80) || 'Celebrity'}\n- Occasion: ${s(input.occasionName, 80)}\n` +
      `- Recipient: ${s(input.recipientName, 80)}\n- User's message: ${s(input.message, 1000)}\n\nOpen with a warm greeting for the occasion, address the ` +
      'recipient personally, incorporate the user\'s message naturally, include positive wishes and end with an uplifting closing.',
    maxTokens: 500,
    temperature: 0.8,
    timeoutMs: 25_000,
  });
  return cleanSpokenText(text).slice(0, 4000);
}

// ── sweeper ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Paid rows stuck in progress (worker down, lost job) are failed and refunded after this long. */
const STUCK_AFTER_MIN = 20;

const SWEEPS: ReadonlyArray<{ table: string; status: string; patch?: Row }> = [
  { table: 'greeting_card_generations', status: 'processing' },
  { table: 'image_promotions', status: 'pending' },
  { table: 'photo_wishes', status: 'processing', patch: { edited_image_url: null } },
];

export async function sweepStuck(deps: Deps): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const w of SWEEPS) {
    if (!deps.schema.table(w.table) || !hasColumn(deps.schema, w.table, 'status')) continue;
    // Only rows this server charged for (a ledger debit keyed on the row) are swept; legacy rows are left alone.
    const stuck = await deps.db.unsafe<{ id: string }[]>(
      `select t.id::text as id from public.${w.table} t
       where t.status = $1 and t.created_at < now() - make_interval(mins => ${STUCK_AFTER_MIN})
         and exists (select 1 from wishme.ledger_entries l where l.idempotency_key = 'content:${w.table}:' || t.id::text || ':debit')
       order by t.created_at limit 100`,
      [w.status],
    );
    let n = 0;
    for (const r of stuck) {
      const done = await failAndRefund(deps, w.table, r.id, [w.status], { error_message: 'Generation timed out. Your wallet has been refunded.', ...(w.patch ?? {}) }, 'stuck');
      if (done) n++;
    }
    out[w.table] = n;
  }
  return out;
}
