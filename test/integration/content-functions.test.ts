/**
 * content-ai edge functions: server prices, charge-before-generate with refunds on failure, the job path the app
 * polls, the wish-celebrity card (covered by the order), photo wishes, image promotions, occasion texts and the
 * text helpers. Gemini is stubbed through globalThis.fetch and B2 is a fake client; nothing leaves the machine.
 */
import type { Job } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generationTiming, sweepStuck } from '../../src/domains/content/generation.js';
import { isOwnStorageUrl } from '../../src/domains/content/media.js';
import { chargeWallet } from '../../src/domains/content/money.js';
import { claimMirror } from '../../src/domains/wallet/mirrors.js';
import { module as contentJobs } from '../../src/jobs/processors/content.js';
import { bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');
const PHOTO = `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`;
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let imageMode: 'ok' | 'no_image' = 'ok';
const geminiCalls: Array<{ image: boolean; parts: number }> = [];

function stubVendors() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://cdn.test/') || url.startsWith('https://f005.backblazeb2.com/')) {
      return new Response(Buffer.from('ref-image'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as {
      contents: Array<{ parts: unknown[] }>;
      generationConfig?: { responseModalities?: string[]; responseSchema?: { type?: string; properties?: Record<string, unknown> } };
    };
    const isImage = !!body.generationConfig?.responseModalities;
    geminiCalls.push({ image: isImage, parts: body.contents[0]!.parts.length });
    if (isImage) {
      if (imageMode === 'no_image') return json(200, { candidates: [{ content: { parts: [{ text: 'no picture today' }] } }] });
      return json(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] });
    }
    const schema = body.generationConfig?.responseSchema;
    let text = 'Wishing you a wonderful day, with love.';
    if (schema?.type === 'ARRAY') text = JSON.stringify(['First suggestion that is long enough', 'Second suggestion that is long enough', 'Third one, also long enough']);
    else if (schema?.properties?.sections) text = JSON.stringify({ title: 'Trip plan', subtitle: 'Goa', sections: [{ heading: 'Goal', body: 'Relax **a lot**' }] });
    else if (schema?.properties?.sheet) text = JSON.stringify({ title: 'Budget', sheet: { columns: ['Item', 'Cost'], rows: [['Hotel', '5000']] } });
    return json(200, { candidates: [{ content: { parts: [{ text }] } }] });
  });
}

const stored = new Map<string, Buffer>();
const fakeB2 = {
  configured: true,
  putBuffer: async (key: string, body: Buffer) => void stored.set(key, body),
  publicUrl: (key: string) => `https://cdn.test/file/wishme/${key}`,
  upload: async () => ({ key: '', bytes: 0 }),
};

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;
let star: TestSession;
let aliceProfile: string;
let celebId: string;

/** Runs the queued content jobs the way the worker would. */
async function drain(): Promise<void> {
  for (const j of t.jobs.enqueued.splice(0)) {
    const p = contentJobs.processors.find((x) => x.queue === j.queue && x.name === j.name);
    if (p) await p.handle({ name: j.name, data: j.data, id: j.opts?.jobId } as unknown as Job, t.deps);
  }
}

/** A background "worker" for requests that wait on their job. */
async function withWorker<T>(fn: () => Promise<T>): Promise<T> {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void drain().finally(() => (busy = false));
  }, 20);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    while (busy) await new Promise((r) => setTimeout(r, 10));
  }
}

const balance = async () => Number((await t.sql`select wallet_balance from public.profiles where id = ${aliceProfile}`)[0]!.wallet_balance);
const setBalance = (r: number) => t.sql`update public.profiles set wallet_balance = ${r} where id = ${aliceProfile}`;
const fn = (name: string, s: TestSession | null, payload: unknown) =>
  t.app.inject({ method: 'POST', url: `/functions/v1/${name}`, headers: s ? bearer(s.access_token) : { apikey: 'test-anon-key' }, payload: payload as object });

beforeAll(async () => {
  t = await bootTest({
    extraFixtures: ['balance-trigger.sql'],
    env: { GEMINI_API_KEY: 'test-gemini-key', B2_PUBLIC_BASE: 'https://cdn.test/file/wishme', B2_ENDPOINT: 'https://s3.test', B2_KEY_ID: 'k', B2_APP_KEY: 's' },
  });
  // Storage routes may have built the shared B2 client already; its network calls are replaced, not the client.
  const b2 = t.deps.memo('b2', () => fakeB2) as unknown as Record<string, unknown>;
  b2.putBuffer = fakeB2.putBuffer;
  b2.upload = fakeB2.upload;
  alice = await signUp(t, 'alice-ai@example.com');
  bob = await signUp(t, 'bob-ai@example.com');
  star = await signUp(t, 'star-ai@example.com');
  aliceProfile = await profileIdOf(t, alice.user.id);
  const starProfile = await profileIdOf(t, star.user.id);
  celebId = (await t.sql<{ id: string }[]>`
    insert into public.celebrities (profile_id, name, category, image_url, service_prices, is_active)
    values (${starProfile}, 'Star Two', 'Singer', 'celebs/star.jpg', ${t.sql.json({ general_wish: 500 })}, true) returning id`)[0]!.id;
  await t.sql`insert into public.plans (name, price, service_discount_percentage) values ('premium', 999, 10)`;
  await t.sql`insert into public.platform_settings (setting_key, setting_value) values
    ('greeting_card_price', '199'), ('photo_wish_price', '99'), ('image_promotion_price', '25')`;
  generationTiming.waitMs = 4000;
  generationTiming.pollMs = 50;
});
beforeEach(() => {
  imageMode = 'ok';
  geminiCalls.length = 0;
  t.jobs.enqueued.length = 0;
  stubVendors();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => t.close());

describe('generate-greeting-card-ai', () => {
  it('charges the discounted server price before generating and returns the finished card', async () => {
    await t.sql`update public.profiles set plan = 'premium' where id = ${aliceProfile}`;
    await setBalance(1000);
    const res = await withWorker(() =>
      fn('generate-greeting-card-ai', alice, { prompt: 'Gold balloons', occasionName: 'Birthday', recipientName: 'Mom', senderName: 'Asha', refinePrompt: true, referenceImageSource: 'upload', referenceImageUrl: PHOTO }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const g = res.json().generation as Record<string, unknown>;
    expect(g).toMatchObject({ status: 'completed', amount_charged: 179, user_id: aliceProfile, reference_image_source: 'upload' });
    expect(String(g.generated_image_url)).toMatch(/^https:\/\/cdn\.test\/file\/wishme\/content\//);
    expect(g.refined_prompt).toBeTruthy();
    expect(res.json()).toMatchObject({ amount_charged: 179, discount_applied: 10 });
    expect(await balance()).toBe(821);
    // The reference photo went to the model with the prompt.
    expect(geminiCalls.some((c) => c.image && c.parts === 2)).toBe(true);
    await t.sql`update public.profiles set plan = 'basic' where id = ${aliceProfile}`;
  });

  it('answers with the processing row when the job is slow, and the app\'s poll sees it complete', async () => {
    await setBalance(1000);
    const wait = generationTiming.waitMs;
    generationTiming.waitMs = 0;
    const res = await fn('generate-greeting-card-ai', alice, { prompt: 'Stars', occasionName: 'Diwali', senderName: 'Asha', refinePrompt: false, referenceImageSource: 'none' });
    generationTiming.waitMs = wait;
    expect(res.statusCode).toBe(200);
    const id = res.json().generation.id as string;
    expect(res.json().generation.status).toBe('processing');
    await drain();
    const poll = await t.app.inject({ method: 'GET', url: `/rest/v1/greeting_card_generations?id=eq.${id}&select=status,generated_image_url,greeting_text,refined_prompt&limit=1`, headers: bearer(alice.access_token) });
    expect(poll.json()[0].status).toBe('completed');
  });

  it('refunds the charge when the model returns no image', async () => {
    await setBalance(500);
    imageMode = 'no_image';
    const res = await withWorker(() => fn('generate-greeting-card-ai', alice, { prompt: 'Cats', occasionName: 'Birthday', senderName: 'A', referenceImageSource: 'none' }));
    expect(res.statusCode).toBe(502);
    expect(await balance()).toBe(500);
    const row = await t.sql`select id, status from public.greeting_card_generations where original_prompt = 'Cats'`;
    expect(row[0]!.status).toBe('failed');
    const refunds = await t.sql`select count(*)::int as n from wishme.ledger_entries where kind = 'refund' and reference_id = ${row[0]!.id}`;
    expect(refunds[0]!.n).toBe(1);
  });

  it('refuses when the wallet is short, with the word the app looks for', async () => {
    await setBalance(10);
    const res = await fn('generate-greeting-card-ai', alice, { prompt: 'Dogs', occasionName: 'Birthday', senderName: 'A' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/insufficient/i);
    expect((await t.sql`select count(*)::int as n from public.greeting_card_generations where original_prompt = 'Dogs'`)[0]!.n).toBe(0);
  });

  it('only accepts a library reference that is one of the caller\'s own cards', async () => {
    await setBalance(1000);
    const res = await fn('generate-greeting-card-ai', alice, { prompt: 'x', occasionName: 'Birthday', senderName: 'A', referenceImageSource: 'library', referenceImageUrl: 'https://evil.example/x.png' });
    expect(res.statusCode).toBe(400);
  });
});

describe('generate-photo-wish', () => {
  it('generates inline, charges once and lets the app\'s payment row be claimed as a mirror', async () => {
    await setBalance(300);
    const res = await fn('generate-photo-wish', alice, { originalImageBase64: PHOTO, occasion: 'Birthday', recipientName: 'Mom', wishMessage: 'Love you', senderName: null, textStyle: 'festive' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { success: boolean; photoWishId: string; editedImageUrl: string; amountCharged: number };
    expect(body).toMatchObject({ success: true, amountCharged: 99 });
    expect(body.editedImageUrl).toMatch(/^https:\/\/cdn\.test\//);
    expect(await balance()).toBe(201);
    const row = (await t.sql`select status, edited_image_url, amount_charged from public.photo_wishes where id = ${body.photoWishId}`)[0]!;
    expect(row).toMatchObject({ status: 'completed', edited_image_url: body.editedImageUrl, amount_charged: '99' });
    const claim = await claimMirror(t.deps.db, { accountId: aliceProfile, absAmountPaise: 9900, kinds: ['photo_wish'], table: 'payment_transactions', referenceId: body.photoWishId });
    expect(claim?.metadata.service_type).toBe('photo_wish');
  });

  it('refunds and marks the wish failed when generation fails', async () => {
    await setBalance(300);
    imageMode = 'no_image';
    const res = await fn('generate-photo-wish', alice, { originalImageBase64: PHOTO, occasion: 'Birthday', recipientName: 'Dad', wishMessage: 'Hi', textStyle: 'elegant' });
    expect(res.statusCode).toBe(502);
    expect(await balance()).toBe(300);
    const row = (await t.sql`select status, edited_image_url from public.photo_wishes where recipient_name = 'Dad'`)[0]!;
    expect(row).toEqual({ status: 'failed', edited_image_url: null });
  });

  it('rejects a body that is not an image', async () => {
    const res = await fn('generate-photo-wish', alice, { originalImageBase64: 'data:text/html;base64,PGgxPg==', occasion: 'B', recipientName: 'M', wishMessage: 'x' });
    expect(res.statusCode).toBe(400);
  });
});

describe('generate-image-promotion', () => {
  it('requires an active subscription, then charges and generates with the celebrity\'s photo', async () => {
    await setBalance(100);
    const payload = { celebrityId: celebId, concept: 'Summer drink ad', brandingDetails: 'Blue logo', referenceImageSource: 'none', referenceImageUrl: null };
    expect((await fn('generate-image-promotion', alice, payload)).statusCode).toBe(403);
    await t.sql`insert into public.celebrity_favorites (user_id, celebrity_id, price_paid, status) values (${aliceProfile}, ${celebId}, 100, 'active')`;
    const res = await withWorker(() => fn('generate-image-promotion', alice, payload));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().generation).toMatchObject({ status: 'completed', price_paid: 25, celebrity_id: celebId });
    expect(await balance()).toBe(75);
    expect(geminiCalls.find((c) => c.image)?.parts).toBe(2);
    await t.deps.resolver.forgetIdentity(star.user.id);
    const dash = await t.app.inject({ method: 'GET', url: `/rest/v1/image_promotions?celebrity_id=eq.${celebId}&status=eq.completed&select=concept,price_paid`, headers: bearer(star.access_token) });
    expect(dash.json()).toEqual([{ concept: 'Summer drink ad', price_paid: 25 }]);
  });
});

describe('generate-wish-celebrity-card', () => {
  async function order(paid: boolean): Promise<string> {
    const r = await t.sql<{ id: string }[]>`
      insert into public.wish_celebrity_orders (user_id, celebrity_id, occasion_type, recipient_name, message, card_prompt, amount_paid, payment_status)
      values (${aliceProfile}, ${celebId}, 'Birthday', 'Asha', 'Happy birthday!', 'Confetti', 500, ${paid ? 'completed' : 'pending'}) returning id`;
    return r[0]!.id;
  }

  it('refuses unpaid orders and other users\' orders', async () => {
    const unpaid = await order(false);
    expect((await fn('generate-wish-celebrity-card', alice, { orderId: unpaid })).statusCode).toBe(403);
    expect((await fn('generate-wish-celebrity-card', bob, { orderId: unpaid })).statusCode).toBe(404);
  });

  it('generates the card for a paid order, counts the attempt and stops at three', async () => {
    const id = await order(true);
    const res = await withWorker(() => fn('generate-wish-celebrity-card', alice, { orderId: id }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ success: true, generation_attempts: 1 });
    expect(res.json().card_url).toMatch(/^https:\/\/cdn\.test\//);
    const row = (await t.sql`select status, generated_card_image_url, card_url, greeting_text from public.wish_celebrity_orders where id = ${id}`)[0]!;
    expect(row.status).toBe('generated');
    expect(row.card_url).toBe(row.generated_card_image_url);
    await t.sql`update public.wish_celebrity_orders set generation_attempts = 3 where id = ${id}`;
    expect((await fn('generate-wish-celebrity-card', alice, { orderId: id })).statusCode).toBe(400);
  });

  it('does not use up an attempt when generation fails', async () => {
    const id = await order(true);
    imageMode = 'no_image';
    const res = await withWorker(() => fn('generate-wish-celebrity-card', alice, { orderId: id }));
    expect(res.statusCode).toBe(502);
    expect((await t.sql`select generation_attempts from public.wish_celebrity_orders where id = ${id}`)[0]!.generation_attempts).toBe(0);
  });
});

describe('occasion bookings', () => {
  it('writes the greeting text and the video script onto the caller\'s own booking', async () => {
    const occasion = (await t.sql<{ id: string }[]>`insert into public.occasions (name, date) values ('Diwali', '2026-11-08') returning id`)[0]!.id;
    const booking = async (type: string) =>
      (await t.sql<{ id: string }[]>`
        insert into public.occasion_bookings (user_id, occasion_id, celebrity_id, booking_type, recipient_name, message, price, status)
        values (${aliceProfile}, ${occasion}, ${celebId}, ${type}, 'Mom', 'Happy Diwali', 0, 'pending') returning id`)[0]!.id;
    const card = await booking('greeting_card');
    const body = { bookingId: card, occasionName: 'Diwali', recipientName: 'Mom', message: 'Happy Diwali', celebrityId: celebId };
    expect((await fn('generate-greeting-card', bob, body)).statusCode).toBe(404);
    const res = await fn('generate-greeting-card', alice, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ success: true, imageUrl: 'https://f005.backblazeb2.com/file/wishmetoday/celebs/star.jpg' });
    const row = (await t.sql`select status, ai_generated_content, greeting_card_url from public.occasion_bookings where id = ${card}`)[0]!;
    expect(row.status).toBe('completed');
    expect(row.ai_generated_content).toBeTruthy();
    const calls = geminiCalls.length;
    await fn('generate-greeting-card', alice, body);
    expect(geminiCalls.length).toBe(calls);

    const video = await booking('video');
    const v = await fn('generate-occasion-video', alice, { ...body, bookingId: video });
    expect(v.statusCode).toBe(200);
    expect(v.json().script).toBeTruthy();
    expect((await t.sql`select status from public.occasion_bookings where id = ${video}`)[0]!.status).toBe('processing');
  });
});

describe('text helpers', () => {
  it('suggests messages and card prompts in the shapes the app reads', async () => {
    const ctx = { celebrityName: 'Star Two', celebrity_name: 'Star Two', occasionType: 'Birthday', occasion: 'Birthday', recipientName: 'Asha', recipient_name: 'Asha' };
    const m = await fn('generate-message-suggestions', alice, ctx);
    expect(m.statusCode).toBe(200);
    expect(m.json().suggestions).toHaveLength(3);
    const p = await fn('suggest-greeting-card-prompts', alice, { ...ctx, message: 'hi' });
    expect(p.json().prompts).toHaveLength(3);
    expect((await fn('generate-message-suggestions', null, ctx)).statusCode).toBe(401);
  });

  it('writes documents as structure and spreadsheets as grids', async () => {
    const d = await fn('generate-document', alice, { topic: 'Goa trip', kind: 'plan', length: 'short' });
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({ ok: true, kind: 'plan', title: 'Trip plan', sheet: null, sections: [{ heading: 'Goal', body: 'Relax **a lot**' }] });
    const s = await fn('generate-document', alice, { topic: 'Budget', kind: 'spreadsheet' });
    expect(s.json().sheet).toMatchObject({ columns: ['Item', 'Cost'] });
    expect((await fn('generate-document', alice, { topic: 'x' })).statusCode).toBe(400);
  });

  it('writes scripts for signed-out callers too and lists languages as plain names', async () => {
    const s = await fn('generate-script', null, { prompt: 'Generate a wish script for Star Two' });
    expect(s.statusCode).toBe(200);
    expect(typeof s.json().script).toBe('string');
    const l = await fn('heygen-get-languages', null, {});
    expect(l.statusCode).toBe(200);
    expect(l.json()).toContain('Hindi');
    expect(typeof l.json()[0]).toBe('string');
  });
});

describe('safety nets', () => {
  it('refunds paid generations stuck in progress', async () => {
    await setBalance(500);
    const id = (await t.sql<{ id: string }[]>`
      insert into public.greeting_card_generations (user_id, original_prompt, occasion_name, recipient_name, status, amount_charged, created_at)
      values (${aliceProfile}, 'stuck', 'Birthday', 'Mom', 'processing', 199, now() - interval '1 hour') returning id`)[0]!.id;
    await t.deps.db.begin((tx) =>
      chargeWallet(tx, t.deps, { profileId: aliceProfile, userId: alice.user.id, kind: 'greeting_card_generation', serviceType: 'greeting_card_generation', pricePaise: 19_900, table: 'greeting_card_generations', rowId: id, description: 'x' }),
    );
    expect(await balance()).toBe(301);
    const swept = await sweepStuck(t.deps);
    expect(swept.greeting_card_generations).toBe(1);
    expect(await balance()).toBe(500);
    expect((await sweepStuck(t.deps)).greeting_card_generations).toBe(0);
  });

  it('reads reference images only from our own storage', () => {
    expect(isOwnStorageUrl(t.deps, 'https://cdn.test/file/wishme/content/a.png')).toBe(true);
    expect(isOwnStorageUrl(t.deps, 'http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isOwnStorageUrl(t.deps, `${t.env.PUBLIC_URL}/storage/v1/object/public/greeting-card-uploads/x.jpg`, 'greeting-card-uploads')).toBe(true);
    expect(isOwnStorageUrl(t.deps, `${t.env.PUBLIC_URL}/storage/v1/object/public/verification-docs/x.jpg`, 'greeting-card-uploads')).toBe(false);
  });
});
