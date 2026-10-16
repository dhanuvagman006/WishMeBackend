/**
 * Suno through sunoapi.org: the song generator behind generate-music / check-music-status (the deployed edge
 * functions use it with model V4_5ALL). Generation is a task: `generate` returns a taskId, `recordInfo` reports its
 * status and, on SUCCESS, the audio URLs on Suno's CDN, which we copy into our own storage.
 *
 * Needs SUNO_API_KEY.
 */
import type { Env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

const BASE = 'https://api.sunoapi.org/api/v1';
const MODEL = 'V4_5ALL';
const MAX_SONG_BYTES = 40 * 1024 * 1024;

export type SunoStatus = 'PENDING' | 'TEXT_SUCCESS' | 'FIRST_SUCCESS' | 'SUCCESS' | 'CREATE_TASK_FAILED' | 'GENERATE_AUDIO_FAILED' | 'CALLBACK_EXCEPTION' | 'SENSITIVE_WORD_ERROR' | string;
export const SUNO_FAILED = new Set(['CREATE_TASK_FAILED', 'GENERATE_AUDIO_FAILED', 'CALLBACK_EXCEPTION', 'SENSITIVE_WORD_ERROR']);

export interface SunoTrack {
  audioUrl?: string;
  audio_url?: string;
  streamAudioUrl?: string;
  imageUrl?: string;
  duration?: number;
}

interface Envelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

export function sunoKey(env: Env): string | undefined {
  return env.SUNO_API_KEY || undefined;
}

export class Suno {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return !!sunoKey(this.env);
  }

  private headers(): Record<string, string> {
    const key = sunoKey(this.env);
    if (!key) throw unavailable('Music generation is not configured');
    return { authorization: `Bearer ${key}` };
  }

  /** Starts a song; returns the task id. Never retried (a retry could start, and bill, a second song). */
  async generate(input: {
    title: string;
    style: string;
    prompt?: string;
    customMode: boolean;
    instrumental: boolean;
    vocalGender?: 'm' | 'f';
    callBackUrl: string;
  }): Promise<string> {
    const { data } = await vendorFetch<Envelope<{ taskId?: string }>>(this.log, {
      vendor: 'suno',
      url: `${BASE}/generate`,
      headers: this.headers(),
      json: { ...input, model: MODEL },
      timeoutMs: 30_000,
    }).catch((e: unknown) => {
      throw clean(e, 'The music service could not start your song. Please try again.');
    });
    if (data?.code !== undefined && data.code !== 200 && data.code !== 0) {
      this.log.warn({ vendor: 'suno', code: data.code }, 'suno rejected the song');
      throw new AppError(502, 'vendor_rejected', data.code === 429 ? 'The music service is busy. Please try again shortly.' : 'The music service could not start your song. Please change the description and try again.');
    }
    const taskId = data?.data?.taskId;
    if (!taskId) throw new AppError(502, 'vendor_error', 'The music service did not start your song. Please try again.');
    return taskId;
  }

  async recordInfo(taskId: string): Promise<{ status: SunoStatus; tracks: SunoTrack[]; message?: string }> {
    const { data } = await vendorFetch<Envelope<{ status?: string; response?: { sunoData?: SunoTrack[]; data?: SunoTrack[] }; sunoData?: SunoTrack[] }>>(this.log, {
      vendor: 'suno',
      url: `${BASE}/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
      headers: this.headers(),
      timeoutMs: 15_000,
      retries: 1,
    }).catch((e: unknown) => {
      throw clean(e, 'Could not check the song status.');
    });
    const d = data?.data;
    const tracks = d?.response?.sunoData ?? d?.response?.data ?? d?.sunoData ?? [];
    return { status: d?.status ?? 'PENDING', tracks, ...(data?.msg ? { message: data.msg.slice(0, 200) } : {}) };
  }
}

/**
 * Downloads a finished song from the URL Suno reported. Only public https hosts (no IP literals or localhost), a
 * timeout and a size cap, so a malformed vendor answer cannot make us fetch internal addresses or unbounded data.
 */
export async function downloadSong(log: Logger, url: string): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AppError(502, 'vendor_error', 'The music service returned an invalid song link.');
  }
  if (u.protocol !== 'https:' || /^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(u.hostname) || u.hostname.endsWith('.local') || u.hostname.endsWith('.internal')) {
    throw new AppError(502, 'vendor_error', 'The music service returned an invalid song link.');
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
  } catch (e) {
    log.warn({ vendor: 'suno-cdn', timeout: (e as Error).name === 'TimeoutError' }, 'song download failed');
    throw new AppError(504, 'vendor_unreachable', 'Could not fetch the finished song. Please try again.');
  }
  log.info({ vendor: 'suno-cdn', status: res.status, ms: Date.now() - started }, 'vendor call');
  if (!res.ok) throw new AppError(502, 'vendor_error', 'Could not fetch the finished song. Please try again.');
  if (Number(res.headers.get('content-length') ?? 0) > MAX_SONG_BYTES) throw new AppError(502, 'vendor_error', 'The song file is too large.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_SONG_BYTES) throw new AppError(502, 'vendor_error', 'The song file is invalid.');
  return buf;
}

function clean(e: unknown, message: string): AppError {
  if (e instanceof AppError) {
    if (e.code === 'vendor_unreachable') return new AppError(504, 'vendor_unreachable', 'The music service is not responding. Please try again.');
    const status = (e.details as { status?: number } | undefined)?.status;
    if (status === 401 || status === 403) return unavailable('Music generation is temporarily unavailable');
    if (status === 429) return new AppError(503, 'vendor_busy', 'The music service is busy. Please try again shortly.');
    return new AppError(502, 'vendor_error', message);
  }
  return new AppError(502, 'vendor_error', message);
}
