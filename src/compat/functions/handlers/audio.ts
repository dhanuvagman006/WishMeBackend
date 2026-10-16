/**
 * Edge-function replacements for the AI Music Studio (components/music/*, hooks/useVoices.ts) and for signed B2 links
 * (services/library.ts, components/bookings/*). See ../registry.ts for the conventions.
 *
 * Deployed behaviour (Supabase audit, 16 Oct 2026): only generate-music charged the wallet; the ElevenLabs functions
 * had no auth and no charge although the tabs show a price and pre-check the balance. Here every paid tab is
 * charged, before the vendor call, at the price the tab shows (domains/audio/charge.ts), and refunded through the
 * ledger if the vendor fails. The app still inserts its own history row afterwards; the server writes its own row.
 *
 * Responses keep the shapes the tabs read: `{ success, audioUrl }`, `{ success, voiceId }`,
 * `{ premadeVoices, clonedVoices }`, `{ generation_id, task_id, status }`, `{ status, song_url, download_url, error }`,
 * `{ signedUrl, url }`. Errors render as `{ error, message }`, which the tabs show (`data.error`).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Deps } from '../../../deps.js';
import { AppError, forbidden, unavailable } from '../../../lib/errors.js';
import { Gemini } from '../../../vendors/gemini.js';
import { AUDIO_PRICES_RUPEES, withCharge, type Payer } from '../../../domains/audio/charge.js';
import { callerOwnsKey } from '../../../domains/audio/file-keys.js';
import { recordHistory } from '../../../domains/audio/history.js';
import { decodeAudio, decodeImage } from '../../../domains/audio/media.js';
import { songStatus, startSong } from '../../../domains/audio/music.js';
import { b2Of, storeMedia } from '../../../domains/audio/storage.js';
import { clonedVoicesOf, elevenOf, OWNER_LABEL, premadeVoices, saveClonedVoice, usableVoice, type VoiceItem } from '../../../domains/audio/voices.js';
import { defineFunctions, parseBody, type FnContext, type FnRateLimit } from '../registry.js';

const MB = 1024 * 1024;
/** Recordings arrive base64-encoded inside JSON: 18 MB of audio is ~24 MB of body. */
const AUDIO_BODY_LIMIT = 25 * MB;
const SIGNED_URL_TTL_SEC = 900;
const TTS_MAX_CHARS = 5000;

const paidLimit: FnRateLimit = { limit: 20, windowSec: 600, by: 'user' };

async function payerOf(c: FnContext): Promise<Payer> {
  const identity = await c.identity();
  if (!c.auth.userId || !identity.profileId) throw forbidden('Profile not found. Please sign in again.', 'profile_not_found');
  return { userId: c.auth.userId, profileId: identity.profileId };
}

function requireEleven(deps: Deps) {
  const el = elevenOf(deps);
  if (!el.configured) throw unavailable('Audio generation is not configured');
  return el;
}

const geminiOf = (deps: Deps) => deps.memo('gemini', () => new Gemini(deps.env, deps.log));

const text = (max: number) => z.string().trim().max(max);
const dataUri = z.string().min(16).max(AUDIO_BODY_LIMIT);

// ── Lyrics ────────────────────────────────────────────────────────────────────────────────────────────────────
const LyricsBody = z.object({
  description: text(1000).min(1, 'Describe the song first'),
  genre: text(40).default('pop'),
  mood: text(40).default('happy'),
  language: text(30).default('English'),
});

// ── Songs ─────────────────────────────────────────────────────────────────────────────────────────────────────
const MusicBody = z.object({
  song_title: text(100).default('Untitled').transform((v) => v || 'Untitled'),
  generation_type: z.enum(['with_lyrics', 'instrumental']),
  genre: text(40).min(1),
  mood: text(40).min(1),
  prompt: text(1000).min(1),
  voice_type: z.enum(['any', 'male', 'female']).optional(),
  language: text(30).optional(),
  lyrics: text(3000).optional(),
  description: text(1000).optional(),
});

const StatusBody = z.object({ generation_id: z.string().uuid() });

// ── ElevenLabs tabs ───────────────────────────────────────────────────────────────────────────────────────────
const voiceId = z.string().trim().regex(/^[A-Za-z0-9]{8,64}$/, 'is not a valid voice');
const TtsBody = z.object({ text: z.string().trim().min(1, 'Please enter some text.').max(TTS_MAX_CHARS, `Text is too long (max ${TTS_MAX_CHARS} characters)`), voiceId });
const StsBody = z.object({ audioBase64: dataUri, voiceId, fileName: text(120).optional() });
const SfxBody = z.object({ text: text(500).min(1, 'Please describe the sound effect.'), durationSeconds: z.coerce.number().min(1).max(22).default(5) });
const CloneBody = z.object({ audioBase64: dataUri, voiceName: text(60).min(1, 'Please enter a voice name.'), voiceDescription: text(500).default('') });
const IsolateBody = z.object({ audioBase64: dataUri, fileName: text(120).optional() });
const ImgMusicBody = z.object({
  imageBase64: z.string().min(16).max(12 * MB),
  musicDescription: text(1000).optional(),
  lyrics: text(3000).optional(),
  genre: text(40).default('ambient'),
  mood: text(40).default('calm'),
  durationSeconds: z.coerce.number().int().min(10).max(60).default(30),
  language: text(30).default('English'),
  uploadedAudioBase64: dataUri.nullable().optional(),
});

const SignedUrlBody = z.object({ fileKey: z.string().min(1).max(512) });

async function voicesHandler(c: FnContext) {
  requireEleven(c.deps);
  const payer = await payerOf(c);
  const cloned = await clonedVoicesOf(c.deps, payer.profileId);
  let premade: VoiceItem[] = [];
  try {
    premade = await premadeVoices(c.deps);
  } catch (e) {
    // The user's own voices are still worth showing when ElevenLabs' catalogue is unreachable.
    c.log.warn({ err: e instanceof AppError ? e.code : 'error' }, 'premade voices unavailable');
  }
  return { body: { success: true, premadeVoices: premade, clonedVoices: cloned, totalCount: premade.length + cloned.length } };
}

export const functions = defineFunctions([
  {
    name: 'generate-lyrics',
    access: 'user',
    // Free, as deployed (no charge in the old function); the rate limit bounds the AI cost.
    rateLimit: { limit: 20, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const b = parseBody(LyricsBody, c.body);
      const gemini = geminiOf(c.deps);
      if (!gemini.configured) throw unavailable('Lyrics generation is not configured');
      const { text: lyrics } = await gemini.text({
        system:
          'You are a lyricist. Output ONLY original song lyrics: no section labels, no title, no commentary, no markdown. ' +
          'Write 3-4 verses with a repeating chorus, natural rhyme and flow, family friendly. Never reproduce existing lyrics.',
        prompt: `Write song lyrics in ${b.language} for a ${b.mood} ${b.genre} song. Theme: ${b.description}. The lyrics MUST be in ${b.language}.`,
        temperature: 0.9,
        maxTokens: 1200,
        timeoutMs: 18_000,
      });
      return { body: { lyrics: cleanLyrics(lyrics).slice(0, 3000) } };
    },
  },
  {
    name: 'generate-music',
    access: 'user',
    rateLimit: { limit: 10, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const b = parseBody(MusicBody, c.body);
      const payer = await payerOf(c);
      const { generationId, taskId } = await startSong(c.deps, payer, {
        title: b.song_title,
        type: b.generation_type,
        genre: b.genre,
        mood: b.mood,
        prompt: b.prompt,
        voiceType: b.voice_type,
        language: b.language,
        lyrics: b.generation_type === 'with_lyrics' ? b.lyrics : undefined,
        description: b.description,
      });
      return { body: { generation_id: generationId, task_id: taskId, status: 'processing' } };
    },
  },
  {
    name: 'check-music-status',
    access: 'user',
    // The app polls every 5 s for up to 60 attempts.
    rateLimit: { limit: 150, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const b = parseBody(StatusBody, c.body);
      const payer = await payerOf(c);
      const s = await songStatus(c.deps, payer, b.generation_id);
      // `status: 'failed'` stops the app's polling loop instead of letting it spin for five minutes.
      if (!s) return { status: 404, body: { status: 'failed', error: 'Generation not found', message: 'Generation not found' } };
      return { body: s };
    },
  },
  {
    name: 'elevenlabs-text-to-speech',
    access: 'user',
    rateLimit: paidLimit,
    handler: async (c) => {
      const b = parseBody(TtsBody, c.body);
      const el = requireEleven(c.deps);
      const payer = await payerOf(c);
      const voice = await usableVoice(c.deps, payer.profileId, b.voiceId);
      const orderId = randomUUID();
      const stored = await withCharge(c.deps, payer, 'tts', orderId, async () => {
        const audio = await el.textToSpeech(voice.voice_id, b.text);
        return storeMedia(c.deps, { profileId: payer.profileId, kind: 'tts', data: audio, mime: 'audio/mpeg', ext: 'mp3' });
      });
      await recordHistory(c.deps, 'tts_generations', {
        id: orderId,
        user_id: payer.profileId,
        text: b.text.slice(0, 500),
        voice_id: voice.voice_id,
        voice_name: voice.name,
        audio_url: stored.url,
        status: 'completed',
        credits_used: AUDIO_PRICES_RUPEES.tts,
      });
      return { body: audioBody(stored) };
    },
  },
  {
    name: 'elevenlabs-speech-to-speech',
    access: 'user',
    rateLimit: paidLimit,
    bodyLimit: AUDIO_BODY_LIMIT,
    handler: async (c) => {
      const b = parseBody(StsBody, c.body);
      const el = requireEleven(c.deps);
      const audio = decodeAudio(b.audioBase64, b.fileName ?? 'recording');
      const payer = await payerOf(c);
      const voice = await usableVoice(c.deps, payer.profileId, b.voiceId);
      const orderId = randomUUID();
      const stored = await withCharge(c.deps, payer, 'voice_conversion', orderId, async () => {
        const out = await el.speechToSpeech(voice.voice_id, audio);
        return storeMedia(c.deps, { profileId: payer.profileId, kind: 'voice-conversion', data: out, mime: 'audio/mpeg', ext: 'mp3' });
      });
      await recordHistory(c.deps, 'voice_conversion_generations', {
        id: orderId,
        user_id: payer.profileId,
        target_voice_id: voice.voice_id,
        target_voice_name: voice.name,
        original_file_name: audio.filename,
        audio_url: stored.url,
        status: 'completed',
        credits_used: AUDIO_PRICES_RUPEES.voice_conversion,
      });
      return { body: audioBody(stored) };
    },
  },
  {
    name: 'elevenlabs-sound-effects',
    access: 'user',
    rateLimit: paidLimit,
    handler: async (c) => {
      const b = parseBody(SfxBody, c.body);
      const el = requireEleven(c.deps);
      const payer = await payerOf(c);
      const orderId = randomUUID();
      const stored = await withCharge(c.deps, payer, 'sfx', orderId, async () => {
        const out = await el.soundEffect(b.text, b.durationSeconds);
        return storeMedia(c.deps, { profileId: payer.profileId, kind: 'sfx', data: out, mime: 'audio/mpeg', ext: 'mp3' });
      });
      await recordHistory(c.deps, 'sound_effect_generations', {
        id: orderId,
        user_id: payer.profileId,
        description: b.text,
        duration_seconds: Math.round(b.durationSeconds),
        audio_url: stored.url,
        status: 'completed',
        credits_used: AUDIO_PRICES_RUPEES.sfx,
      });
      return { body: audioBody(stored) };
    },
  },
  {
    name: 'elevenlabs-clone-voice',
    access: 'user',
    rateLimit: { limit: 5, windowSec: 3600, by: 'user' },
    bodyLimit: AUDIO_BODY_LIMIT,
    handler: async (c) => {
      const b = parseBody(CloneBody, c.body);
      const el = requireEleven(c.deps);
      const sample = decodeAudio(b.audioBase64, 'sample');
      const payer = await payerOf(c);
      const orderId = randomUUID();
      const { voice_id } = await withCharge(c.deps, payer, 'voice_clone', orderId, async () => {
        const v = await el.addVoice({ name: b.voiceName, description: b.voiceDescription, sample, labels: { [OWNER_LABEL]: payer.userId } });
        // Inside the charge: if the ownership row cannot be written the clone would be unusable, so refund.
        await saveClonedVoice(c.deps, payer.profileId, v.voice_id, b.voiceName, b.voiceDescription);
        return v;
      });
      return {
        body: { success: true, voiceId: voice_id, voiceName: b.voiceName, message: 'Voice cloned successfully! You can now use it for text-to-speech and music.' },
      };
    },
  },
  {
    name: 'elevenlabs-audio-isolation',
    access: 'user',
    rateLimit: paidLimit,
    bodyLimit: AUDIO_BODY_LIMIT,
    handler: async (c) => {
      const b = parseBody(IsolateBody, c.body);
      const el = requireEleven(c.deps);
      // ASSUMPTION: the app sends no file name (it records 'audio.wav' by default); an optional fileName is honoured.
      const audio = decodeAudio(b.audioBase64, b.fileName ?? 'audio.wav');
      const payer = await payerOf(c);
      const orderId = randomUUID();
      const stored = await withCharge(c.deps, payer, 'audio_isolation', orderId, async () => {
        const out = await el.isolate(audio);
        return storeMedia(c.deps, { profileId: payer.profileId, kind: 'isolation', data: out, mime: 'audio/mpeg', ext: 'mp3' });
      });
      await recordHistory(c.deps, 'audio_isolation_generations', {
        id: orderId,
        user_id: payer.profileId,
        original_file_name: audio.filename,
        audio_url: stored.url,
        status: 'completed',
        credits_used: AUDIO_PRICES_RUPEES.audio_isolation,
      });
      return { body: audioBody(stored) };
    },
  },
  {
    name: 'elevenlabs-image-music-video',
    access: 'user',
    rateLimit: paidLimit,
    bodyLimit: AUDIO_BODY_LIMIT + 12 * MB,
    handler: async (c) => {
      const b = parseBody(ImgMusicBody, c.body);
      const image = decodeImage(b.imageBase64);
      const uploaded = b.uploadedAudioBase64 ? decodeAudio(b.uploadedAudioBase64, 'uploaded') : null;
      const el = uploaded ? null : requireEleven(c.deps);
      const payer = await payerOf(c);
      // As deployed: vocals when lyrics are given. The price follows: ₹150 with vocals, ₹120 otherwise (the tab's
      // estimate, including an uploaded track, which still gets stored and returned for the video).
      const hasVocals = !!b.lyrics;
      const service = hasVocals ? 'image_music_vocals' : 'image_music_instrumental';
      const orderId = randomUUID();
      const result = await withCharge(c.deps, payer, service, orderId, async () => {
        let audio: { data: Buffer; mime: string; ext: string };
        if (uploaded) {
          audio = { data: uploaded.data, mime: uploaded.mime, ext: uploaded.ext === 'bin' ? 'mp3' : uploaded.ext };
        } else {
          // Same prompt shape as the deployed function.
          let prompt = `A ${b.mood} ${b.genre} ${hasVocals ? 'song with vocals' : 'instrumental track'}`;
          if (b.musicDescription) prompt += `. ${b.musicDescription.slice(0, 250)}`;
          if (hasVocals) prompt += `. Sing these lyrics in ${b.language}: ${b.lyrics!.slice(0, 400)}`;
          const data = await el!.composeMusic({ prompt: prompt.slice(0, 4000), lengthMs: b.durationSeconds * 1000, instrumental: !hasVocals });
          audio = { data, mime: 'audio/mpeg', ext: 'mp3' };
        }
        const [audioStored, imageStored] = await Promise.all([
          storeMedia(c.deps, { profileId: payer.profileId, kind: 'image-music', ...audio }),
          storeMedia(c.deps, { profileId: payer.profileId, kind: 'image-music', data: image.data, mime: image.mime, ext: image.ext }),
        ]);
        return { audioStored, imageStored };
      });
      await recordHistory(c.deps, 'image_music_generations', {
        id: orderId,
        user_id: payer.profileId,
        // A link, not the base64 image the app writes into its own row.
        image_url: result.imageStored.key ? result.imageStored.url : null,
        audio_url: result.audioStored.url,
        video_url: null,
        description: b.musicDescription ?? '',
        lyrics: hasVocals ? (b.lyrics ?? null) : null,
        genre: b.genre,
        mood: b.mood,
        duration_seconds: b.durationSeconds,
        has_vocals: hasVocals,
        amount_charged: AUDIO_PRICES_RUPEES[service],
        status: 'completed',
        completed_at: new Date(),
      });
      // As deployed: no server-side MP4. Web builds the video from image + audio; native offers no video download
      // when videoUrl is absent. The deployed function echoed imageBase64 back; the app falls back to its own copy.
      return {
        body: {
          ...audioBody(result.audioStored),
          duration: b.durationSeconds,
          hasVocals,
          message: hasVocals ? 'Your song with vocals is ready!' : 'Your instrumental music is ready!',
        },
      };
    },
  },
  { name: 'get-user-voices', access: 'user', rateLimit: { limit: 60, windowSec: 600, by: 'user' }, handler: voicesHandler },
  { name: 'elevenlabs-get-user-voices', access: 'user', rateLimit: { limit: 60, windowSec: 600, by: 'user' }, handler: voicesHandler },
  {
    name: 'b2-get-signed-url',
    access: 'user',
    rateLimit: { limit: 120, windowSec: 600, by: 'user' },
    handler: async (c) => {
      const b = parseBody(SignedUrlBody, c.body);
      const b2 = b2Of(c.deps);
      if (!b2.configured) throw unavailable('File storage is not configured');
      const owns = await callerOwnsKey(c.deps, c.auth.userId!, await c.identity(), b.fileKey);
      if (!owns) throw forbidden('You do not have access to this file');
      // The deployed function signed keys in the main bucket (B2_BUCKET_NAME), for anyone and for a day; here only
      // the owner, for 15 minutes (the app asks again on every open).
      const signedUrl = await b2.signedGetUrl(b.fileKey, { isPrivate: false, expiresSec: SIGNED_URL_TTL_SEC });
      return { body: { success: true, signedUrl, url: signedUrl } };
    },
  },
]);

/**
 * The deployed functions answered `audioUrl` as an inline data: URI and `b2Url` as the stored copy; the tabs play
 * `audioUrl` (Img+Music prefers `b2Url`). Here both point at the stored copy, which also keeps responses small.
 */
function audioBody(stored: { url: string; key: string | null }) {
  return { success: true, audioUrl: stored.url, b2Url: stored.key ? stored.url : null };
}

/** Removes section labels the model may still add ([Verse 1], "Chorus:"), as the deployed function did. */
export function cleanLyrics(text: string): string {
  return text
    .replace(/\[(Verse|Chorus|Bridge|Intro|Outro|Pre-Chorus|Hook|Refrain)[^\]]*\]/gi, '')
    .replace(/^(Verse|Chorus|Bridge|Intro|Outro|Pre-Chorus|Hook|Refrain)[\s\d:]*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
