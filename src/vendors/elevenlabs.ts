/**
 * ElevenLabs: text-to-speech, speech-to-speech, sound effects, instant voice cloning, audio isolation, voice listing
 * and music composition. Every call has a timeout; keys and bodies are never logged.
 *
 * JSON calls go through lib/http.ts (vendorFetch). The audio endpoints answer with raw bytes, which vendorFetch cannot
 * return (it decodes non-JSON bodies as UTF-8 text), so `binaryCall` below gives those calls the same guarantees
 * (timeout, bounded size, status-only logging, AppError on failure) until vendorFetch grows a binary response mode.
 */
import type { Env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

const BASE = 'https://api.elevenlabs.io';
/** mp3 at 44.1 kHz / 128 kbps: plays everywhere the app runs, and the app names files by the data: mime. */
const OUTPUT_FORMAT = 'mp3_44100_128';
/** Largest audio answer we accept from ElevenLabs (a 5-minute 128 kbps mp3 is ~5 MB). */
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

// The models the deployed functions used (eleven_multilingual_v2 / _sts_v2 / music_v1).
const TTS_MODEL = 'eleven_multilingual_v2';
const STS_MODEL = 'eleven_multilingual_sts_v2';
const MUSIC_MODEL = 'music_v1';

export interface AudioInput {
  data: Buffer;
  mime: string;
  filename: string;
}

export interface ElevenVoice {
  voice_id: string;
  name: string;
  category: string;
  labels?: Record<string, string> | null;
  preview_url?: string | null;
}

interface VoicePage {
  voices?: ElevenVoice[];
  has_more?: boolean;
  next_page_token?: string | null;
}

export class ElevenLabs {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return !!this.env.ELEVENLABS_API_KEY;
  }

  private key(): string {
    if (!this.env.ELEVENLABS_API_KEY) throw unavailable('Audio generation is not configured');
    return this.env.ELEVENLABS_API_KEY;
  }

  async textToSpeech(voiceId: string, text: string): Promise<Buffer> {
    return this.binaryCall('tts', `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`, {
      json: { text, model_id: TTS_MODEL },
      timeoutMs: 90_000,
    });
  }

  async speechToSpeech(voiceId: string, audio: AudioInput): Promise<Buffer> {
    const form = new FormData();
    form.append('audio', new Blob([audio.data], { type: audio.mime }), audio.filename);
    form.append('model_id', STS_MODEL);
    form.append('remove_background_noise', 'false');
    return this.binaryCall('speech-to-speech', `/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`, {
      form,
      timeoutMs: 120_000,
    });
  }

  async soundEffect(text: string, durationSeconds: number): Promise<Buffer> {
    return this.binaryCall('sound-generation', `/v1/sound-generation?output_format=${OUTPUT_FORMAT}`, {
      json: { text, duration_seconds: durationSeconds, prompt_influence: 0.3 },
      timeoutMs: 90_000,
    });
  }

  async isolate(audio: AudioInput): Promise<Buffer> {
    const form = new FormData();
    form.append('audio', new Blob([audio.data], { type: audio.mime }), audio.filename);
    return this.binaryCall('audio-isolation', '/v1/audio-isolation', { form, timeoutMs: 120_000 });
  }

  /** Composes music from a prompt; synchronous on ElevenLabs' side (can take a minute or more). */
  async composeMusic(input: { prompt: string; lengthMs: number; instrumental: boolean }): Promise<Buffer> {
    return this.binaryCall('music', `/v1/music?output_format=${OUTPUT_FORMAT}`, {
      json: {
        prompt: input.prompt,
        music_length_ms: input.lengthMs,
        model_id: MUSIC_MODEL,
        force_instrumental: input.instrumental,
      },
      timeoutMs: 300_000,
    });
  }

  /**
   * Instant voice clone. `labels` is sent as a serialized JSON dictionary. Ownership itself is kept in
   * public.user_cloned_voices; the label is an extra marker. ASSUMPTION: ElevenLabs accepts the free-form key.
   */
  async addVoice(input: { name: string; description: string; sample: AudioInput; labels: Record<string, string> }): Promise<{ voice_id: string }> {
    const form = new FormData();
    form.append('name', input.name);
    if (input.description) form.append('description', input.description);
    form.append('files', new Blob([input.sample.data], { type: input.sample.mime }), input.sample.filename);
    form.append('labels', JSON.stringify(input.labels));
    form.append('remove_background_noise', 'false');
    const { data } = await vendorFetch<{ voice_id?: string }>(this.log, {
      vendor: 'elevenlabs',
      url: `${BASE}/v1/voices/add`,
      headers: { 'xi-api-key': this.key() },
      body: form,
      timeoutMs: 120_000,
    }).catch((e: unknown) => {
      throw sanitise(e, 'Voice cloning failed. Please try a clearer recording.');
    });
    if (!data?.voice_id) throw new AppError(502, 'vendor_error', 'Voice cloning failed. Please try again.');
    return { voice_id: data.voice_id };
  }

  /** One page of voices (v2 listing). */
  async listVoices(q: { category: 'premade' | 'cloned'; pageToken?: string | null }): Promise<VoicePage> {
    const params = new URLSearchParams({ category: q.category, page_size: '100', include_total_count: 'false' });
    if (q.pageToken) params.set('next_page_token', q.pageToken);
    const { data } = await vendorFetch<VoicePage>(this.log, {
      vendor: 'elevenlabs',
      url: `${BASE}/v2/voices?${params.toString()}`,
      headers: { 'xi-api-key': this.key() },
      timeoutMs: 15_000,
      retries: 2,
    }).catch((e: unknown) => {
      throw sanitise(e, 'Could not load voices. Please try again.');
    });
    return data ?? {};
  }

  private async binaryCall(
    op: string,
    path: string,
    opts: { json?: unknown; form?: FormData; timeoutMs: number },
  ): Promise<Buffer> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.key(),
          accept: 'audio/mpeg',
          ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.form,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      if (e instanceof AppError) throw e;
      const timeout = (e as Error).name === 'TimeoutError';
      this.log.warn({ vendor: 'elevenlabs', op, timeout, ms: Date.now() - started }, 'vendor call error');
      throw new AppError(504, 'vendor_unreachable', 'The audio service is not responding. Please try again.');
    }
    const ms = Date.now() - started;
    this.log.info({ vendor: 'elevenlabs', op, status: res.status, ms }, 'vendor call');
    if (!res.ok) {
      // The error body is small JSON ({ detail: { status, message } }); keep only the vendor's status word.
      const detail = await res.json().catch(() => null) as { detail?: { status?: string } | unknown } | null;
      const word = typeof (detail?.detail as { status?: unknown } | undefined)?.status === 'string' ? (detail!.detail as { status: string }).status : undefined;
      this.log.warn({ vendor: 'elevenlabs', op, status: res.status, reason: word }, 'vendor call failed');
      throw vendorError(res.status, word);
    }
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_AUDIO_BYTES) throw new AppError(502, 'vendor_error', 'The generated audio is too large.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new AppError(502, 'empty_generation', 'The audio service returned no audio. Please try again.');
    if (buf.length > MAX_AUDIO_BYTES) throw new AppError(502, 'vendor_error', 'The generated audio is too large.');
    return buf;
  }
}

function vendorError(status: number, word?: string): AppError {
  if (status === 401 || status === 403) return unavailable('Audio generation is temporarily unavailable');
  if (status === 422 || status === 400) {
    return new AppError(502, 'vendor_rejected', word === 'voice_not_found' ? 'Voice not available' : 'The audio service could not process this request. Please change the input and try again.');
  }
  if (status === 429) return new AppError(503, 'vendor_busy', 'The audio service is busy. Please try again in a minute.');
  return new AppError(502, 'vendor_error', 'Audio generation failed. Please try again.');
}

/** Drops vendor response bodies from errors so they never reach logs or clients. */
function sanitise(e: unknown, message: string): AppError {
  if (e instanceof AppError) {
    const status = (e.details as { status?: number } | undefined)?.status;
    if (e.code === 'vendor_error' && typeof status === 'number') {
      const err = vendorError(status);
      return status === 422 || status === 400 ? new AppError(err.status, err.code, message) : err;
    }
    return new AppError(e.status, e.code, e.code === 'vendor_unreachable' ? 'The audio service is not responding. Please try again.' : e.message);
  }
  return new AppError(502, 'vendor_error', message);
}
