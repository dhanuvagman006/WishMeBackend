/**
 * AI Music Studio functions with ElevenLabs, Suno and Gemini stubbed at globalThis.fetch. B2 is not configured, so
 * generated audio comes back inline (data: URI), which the tabs accept.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anon, bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

process.env.SUNO_API_KEY = 'test-suno-key';

let t: TestCtx;
const realFetch = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[] = [];
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let routes: Array<[RegExp, Handler]> = [];

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const mp3 = (bytes = 2048) => new Response(Buffer.alloc(bytes, 7), { status: 200, headers: { 'content-type': 'audio/mpeg' } });

function stub(list: Array<[RegExp, Handler]>) {
  routes = list;
}

const PREMADE = { voices: [{ voice_id: 'premadeVoice0001', name: 'Aria', category: 'premade', preview_url: 'https://x/p.mp3' }], has_more: false };
const AUDIO_DATA = `data:audio/m4a;base64,${Buffer.alloc(4096, 3).toString('base64')}`;

let alice: TestSession;
let bob: TestSession;
let aliceProfile: string;
let bobProfile: string;

async function setBalance(profileId: string, rupees: number) {
  await t.sql`update public.profiles set wallet_balance = ${rupees} where id = ${profileId}`;
}
async function balance(profileId: string): Promise<number> {
  const r = await t.sql<{ b: number }[]>`select wallet_balance as b from public.profiles where id = ${profileId}`;
  return Number(r[0]!.b);
}
async function ledger(profileId: string) {
  return t.sql<{ kind: string; amount_paise: string; idempotency_key: string; metadata: Record<string, unknown> }[]>`
    select kind, amount_paise::text, idempotency_key, metadata from wishme.ledger_entries where account_id = ${profileId} order by created_at`;
}
const call = (name: string, token: string | null, payload: unknown) =>
  t.app.inject({ method: 'POST', url: `/functions/v1/${name}`, headers: token ? bearer(token) : anon(), payload: payload as object });

beforeAll(async () => {
  t = await bootTest({ env: { ELEVENLABS_API_KEY: 'test-el-key', GEMINI_API_KEY: 'test-gemini-key' } });
  await t.sql.unsafe(`
    create table if not exists public.user_cloned_voices (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references public.profiles (id) on delete cascade,
      elevenlabs_voice_id text not null,
      voice_name text not null,
      voice_description text,
      created_at timestamptz default now(),
      unique (user_id, elevenlabs_voice_id)
    );`);
  await t.deps.schema.load();
  alice = await signUp(t, 'alice-audio@example.com');
  bob = await signUp(t, 'bob-audio@example.com');
  aliceProfile = await profileIdOf(t, alice.user.id);
  bobProfile = await profileIdOf(t, bob.user.id);
  await t.sql`insert into public.user_cloned_voices (user_id, elevenlabs_voice_id, voice_name) values (${bobProfile}, 'bobsClonedVoice01', 'Bob voice')`;

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    let body: unknown = init.body;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: url.href, method: init.method ?? 'GET', body });
    const route = routes.find(([re]) => re.test(url.href));
    if (!route) throw new TypeError(`unexpected fetch ${url.href}`);
    return route[1](url, init);
  }) as typeof fetch;
});

afterEach(() => {
  calls = [];
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await t.close();
});

describe('text to speech', () => {
  it('charges ₹50 before the vendor call, returns the audio and writes the history row', async () => {
    await setBalance(aliceProfile, 500);
    stub([
      [/\/v2\/voices/, () => json(PREMADE)],
      [/\/v1\/text-to-speech\/premadeVoice0001/, () => mp3()],
    ]);
    const res = await call('elevenlabs-text-to-speech', alice.access_token, { text: 'Happy birthday!', voiceId: 'premadeVoice0001' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.audioUrl).toMatch(/^data:audio\/mpeg;base64,/);
    expect(await balance(aliceProfile)).toBe(450);
    const l = await ledger(aliceProfile);
    expect(l.at(-1)).toMatchObject({ kind: 'music_generation', amount_paise: '-5000' });
    expect(l.at(-1)!.metadata).toMatchObject({ service_type: 'tts', mirrorable: true });
    const rows = await t.sql`select text, voice_id, voice_name, credits_used, status from public.tts_generations where user_id = ${aliceProfile}`;
    expect(rows).toEqual([{ text: 'Happy birthday!', voice_id: 'premadeVoice0001', voice_name: 'Aria', credits_used: 50, status: 'completed' }]);
    const tts = calls.find((c) => c.url.includes('text-to-speech'))!;
    expect(tts.body).toMatchObject({ text: 'Happy birthday!', model_id: 'eleven_multilingual_v2' });
  });

  it("refuses another user's cloned voice without charging", async () => {
    await setBalance(aliceProfile, 500);
    stub([[/\/v2\/voices/, () => json(PREMADE)]]);
    const res = await call('elevenlabs-text-to-speech', alice.access_token, { text: 'hi', voiceId: 'bobsClonedVoice01' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Voice not available');
    expect(await balance(aliceProfile)).toBe(500);
    expect(calls.some((c) => c.url.includes('text-to-speech'))).toBe(false);
  });

  it('refunds through the ledger when ElevenLabs fails', async () => {
    await setBalance(aliceProfile, 500);
    stub([
      [/\/v2\/voices/, () => json(PREMADE)],
      [/\/v1\/text-to-speech\//, () => json({ detail: { status: 'internal' } }, 500)],
    ]);
    const res = await call('elevenlabs-text-to-speech', alice.access_token, { text: 'hello', voiceId: 'premadeVoice0001' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBeTruthy();
    expect(await balance(aliceProfile)).toBe(500);
    const l = await ledger(aliceProfile);
    const [debit, credit] = l.slice(-2);
    expect(debit).toMatchObject({ kind: 'music_generation', amount_paise: '-5000' });
    expect(credit).toMatchObject({ kind: 'refund', amount_paise: '5000' });
    expect(credit!.idempotency_key).toBe(debit!.idempotency_key.replace(':debit', ':refund'));
    const history = await t.sql`select transaction_type, payment_method from public.wallet_transactions where user_id = ${aliceProfile} order by created_at desc limit 1`;
    expect(history[0]).toMatchObject({ transaction_type: 'admin_credit', payment_method: 'wallet' });
  });

  it('answers 400 "Insufficient wallet balance" without calling the vendor', async () => {
    await setBalance(aliceProfile, 10);
    stub([[/\/v2\/voices/, () => json(PREMADE)]]);
    const res = await call('elevenlabs-text-to-speech', alice.access_token, { text: 'hello', voiceId: 'premadeVoice0001' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/insufficient wallet balance/i);
    expect(calls.some((c) => c.url.includes('text-to-speech'))).toBe(false);
  });

  it('requires a signed-in user', async () => {
    const res = await call('elevenlabs-text-to-speech', null, { text: 'hello', voiceId: 'premadeVoice0001' });
    expect(res.statusCode).toBe(401);
  });
});

describe('voices', () => {
  it('clones a voice for ₹150, records the owner and lists only the caller’s clones', async () => {
    await setBalance(aliceProfile, 500);
    let labels = '';
    stub([
      [
        /\/v1\/voices\/add/,
        (_u, init) => {
          labels = String((init.body as FormData).get('labels'));
          return json({ voice_id: 'aliceClone000001', requires_verification: false });
        },
      ],
      [/\/v2\/voices/, () => json(PREMADE)],
    ]);
    const res = await call('elevenlabs-clone-voice', alice.access_token, { audioBase64: AUDIO_DATA, voiceName: 'My Voice', voiceDescription: 'warm' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, voiceId: 'aliceClone000001' });
    expect(JSON.parse(labels)).toEqual({ wishme_user_id: alice.user.id });
    expect(await balance(aliceProfile)).toBe(350);

    const voices = await call('get-user-voices', alice.access_token, {});
    expect(voices.statusCode).toBe(200);
    const v = voices.json();
    expect(v.premadeVoices).toEqual([{ voice_id: 'premadeVoice0001', name: 'Aria', category: 'premade', preview_url: 'https://x/p.mp3' }]);
    expect(v.clonedVoices.map((x: { voice_id: string }) => x.voice_id)).toEqual(['aliceClone000001']);

    const fallback = await call('elevenlabs-get-user-voices', bob.access_token, {});
    expect(fallback.json().clonedVoices.map((x: { voice_id: string }) => x.voice_id)).toEqual(['bobsClonedVoice01']);
  });

  it('converts speech with the caller’s own clone and records the target voice', async () => {
    await setBalance(aliceProfile, 500);
    stub([[/\/v1\/speech-to-speech\/aliceClone000001/, () => mp3()]]);
    const res = await call('elevenlabs-speech-to-speech', alice.access_token, { audioBase64: AUDIO_DATA, voiceId: 'aliceClone000001' });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(await balance(aliceProfile)).toBe(425);
    const rows = await t.sql`select target_voice_id, target_voice_name, credits_used from public.voice_conversion_generations where user_id = ${aliceProfile}`;
    expect(rows[0]).toMatchObject({ target_voice_id: 'aliceClone000001', target_voice_name: 'My Voice', credits_used: 75 });
  });

  it('rejects audio that is not a supported data URI before charging', async () => {
    await setBalance(aliceProfile, 500);
    const res = await call('elevenlabs-audio-isolation', alice.access_token, { audioBase64: 'data:text/html;base64,PGh0bWw+PC9odG1sPg==' });
    expect(res.statusCode).toBe(400);
    expect(await balance(aliceProfile)).toBe(500);
  });
});

describe('sound effects, isolation, image + music', () => {
  it('sound effects charge ₹60 and isolation ₹40', async () => {
    await setBalance(aliceProfile, 500);
    stub([
      [/\/v1\/sound-generation/, () => mp3()],
      [/\/v1\/audio-isolation/, () => mp3()],
    ]);
    const sfx = await call('elevenlabs-sound-effects', alice.access_token, { text: 'Thunder', durationSeconds: 5 });
    expect(sfx.statusCode).toBe(200);
    const iso = await call('elevenlabs-audio-isolation', alice.access_token, { audioBase64: AUDIO_DATA });
    expect(iso.statusCode).toBe(200);
    expect(await balance(aliceProfile)).toBe(400);
    const s = await t.sql`select description, duration_seconds, credits_used from public.sound_effect_generations where user_id = ${aliceProfile}`;
    expect(s[0]).toMatchObject({ description: 'Thunder', duration_seconds: 5, credits_used: 60 });
  });

  it('image + music with lyrics composes vocals for ₹150', async () => {
    await setBalance(aliceProfile, 500);
    stub([[/\/v1\/music/, () => mp3()]]);
    const img = `data:image/jpeg;base64,${Buffer.alloc(2000, 9).toString('base64')}`;
    const res = await call('elevenlabs-image-music-video', alice.access_token, {
      imageBase64: img,
      lyrics: 'La la la',
      genre: 'pop',
      mood: 'happy',
      durationSeconds: 20,
      language: 'Hindi',
      uploadedAudioBase64: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, hasVocals: true });
    expect(await balance(aliceProfile)).toBe(350);
    const music = calls.find((c) => c.url.includes('/v1/music'))!;
    expect(music.body).toMatchObject({ music_length_ms: 20000, force_instrumental: false });
    const row = await t.sql`select has_vocals, amount_charged::int as amount from public.image_music_generations where user_id = ${aliceProfile}`;
    expect(row[0]).toMatchObject({ has_vocals: true, amount: 150 });
  });
});

describe('songs (Suno)', () => {
  it('charges, starts a Suno task and completes it on demand when polled', async () => {
    await setBalance(aliceProfile, 500);
    stub([[/sunoapi\.org\/api\/v1\/generate$/, () => json({ code: 200, msg: 'success', data: { taskId: 'task-123' } })]]);
    const start = await call('generate-music', alice.access_token, {
      song_title: 'Birthday',
      generation_type: 'with_lyrics',
      genre: 'pop',
      mood: 'happy',
      prompt: 'a birthday song',
      voice_type: 'female',
      language: 'Hindi',
      lyrics: 'Happy birthday to you',
    });
    expect(start.statusCode).toBe(200);
    const { generation_id, task_id, status } = start.json();
    expect(task_id).toBe('task-123');
    expect(status).toBe('processing');
    expect(await balance(aliceProfile)).toBe(350);
    const suno = calls.find((c) => c.url.endsWith('/generate'))!;
    expect(suno.body).toMatchObject({ customMode: true, instrumental: false, prompt: 'Happy birthday to you', vocalGender: 'f', model: 'V4_5ALL' });

    stub([[/record-info\?taskId=task-123/, () => json({ code: 200, data: { status: 'FIRST_SUCCESS' } })]]);
    const pending = await call('check-music-status', alice.access_token, { generation_id });
    expect(pending.json()).toMatchObject({ status: 'processing' });

    stub([
      [/record-info\?taskId=task-123/, () => json({ code: 200, data: { status: 'SUCCESS', response: { sunoData: [{ audioUrl: 'https://cdn.suno.example/song.mp3', duration: 121.4 }] } } })],
      [/cdn\.suno\.example/, () => mp3(5000)],
    ]);
    const done = await call('check-music-status', alice.access_token, { generation_id });
    expect(done.statusCode).toBe(200);
    const d = done.json();
    expect(d.status).toBe('completed');
    expect(d.song_url).toMatch(/^data:audio\/mpeg;base64,/);
    expect(d.download_url).toBe(d.song_url);
    const row = await t.sql`select status::text, price_paid, duration, api_task_id from public.music_generations where id = ${generation_id}`;
    expect(row[0]).toMatchObject({ status: 'completed', price_paid: 150, duration: 121, api_task_id: 'task-123' });

    // Bob cannot read Alice's song; the 404 still tells the app's poller to stop.
    const other = await call('check-music-status', bob.access_token, { generation_id });
    expect(other.statusCode).toBe(404);
    expect(other.json().status).toBe('failed');
  });

  it('refunds when Suno reports a failed generation, once', async () => {
    await setBalance(aliceProfile, 500);
    stub([[/sunoapi\.org\/api\/v1\/generate$/, () => json({ code: 200, data: { taskId: 'task-fail' } })]]);
    const start = await call('generate-music', alice.access_token, { song_title: 'x', generation_type: 'instrumental', genre: 'lofi', mood: 'calm', prompt: 'rain' });
    const { generation_id } = start.json();
    expect(await balance(aliceProfile)).toBe(400);
    stub([[/record-info/, () => json({ code: 200, data: { status: 'GENERATE_AUDIO_FAILED' } })]]);
    const first = await call('check-music-status', alice.access_token, { generation_id });
    expect(first.json()).toMatchObject({ status: 'failed' });
    const again = await call('check-music-status', alice.access_token, { generation_id });
    expect(again.json()).toMatchObject({ status: 'failed' });
    expect(await balance(aliceProfile)).toBe(500);
    const refunds = (await ledger(aliceProfile)).filter((l) => l.idempotency_key === `audio:${generation_id}:refund`);
    expect(refunds).toHaveLength(1);
  });

  it('refunds immediately when Suno refuses to start', async () => {
    await setBalance(aliceProfile, 500);
    stub([[/sunoapi\.org\/api\/v1\/generate$/, () => json({ code: 430, msg: 'bad words' })]]);
    const res = await call('generate-music', alice.access_token, { song_title: 'x', generation_type: 'instrumental', genre: 'lofi', mood: 'calm', prompt: 'rain' });
    expect(res.statusCode).toBe(502);
    expect(await balance(aliceProfile)).toBe(500);
    const row = await t.sql`select status::text from public.music_generations where user_id = ${aliceProfile} order by created_at desc limit 1`;
    expect(row[0]!.status).toBe('failed');
  });
});

describe('lyrics', () => {
  it('returns clean lyrics without section labels and charges nothing', async () => {
    await setBalance(aliceProfile, 500);
    stub([[/generativelanguage/, () => json({ candidates: [{ content: { parts: [{ text: '[Verse 1]\nSun is high\n\n\n\nChorus:\nWe fly' }] } }] })]]);
    const res = await call('generate-lyrics', alice.access_token, { description: 'summer', genre: 'pop', mood: 'happy', language: 'English' });
    expect(res.statusCode).toBe(200);
    expect(res.json().lyrics).toBe('Sun is high\n\nWe fly');
    expect(await balance(aliceProfile)).toBe(500);
  });
});
