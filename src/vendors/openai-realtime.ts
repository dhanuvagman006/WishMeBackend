/**
 * OpenAI Realtime: short-lived client secrets for the app's own Realtime WebSocket.
 *
 * The app connects to wss://api.openai.com/v1/realtime?model=<model> itself, authenticated with an ephemeral key
 * (`ek_…`), so the server's API key never leaves the server. REST: POST https://api.openai.com/v1/realtime/client_secrets
 * (Authorization: Bearer <key>) with { expires_after: { anchor: 'created_at', seconds }, session } → { value,
 * expires_at, session }. The session fixes the model, 24 kHz PCM audio both ways and the voice; the app adds the
 * instructions and tools with session.update once connected.
 */
import type { Env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

const CLIENT_SECRETS = 'https://api.openai.com/v1/realtime/client_secrets';

export interface RealtimeSecret {
  token: string;
  model: string;
  voice: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

export class OpenAIRealtime {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return !!this.env.OPENAI_API_KEY;
  }

  get model(): string {
    return this.env.OPENAI_REALTIME_MODEL;
  }

  /** An ephemeral key valid for `ttlSec` (10..7200) seconds. */
  async mint(opts: { ttlSec: number }): Promise<RealtimeSecret> {
    if (!this.env.OPENAI_API_KEY) throw unavailable('Voice assistant is not configured');
    const voice = this.env.OPENAI_REALTIME_VOICE;
    const { data } = await vendorFetch<{ value?: string; expires_at?: number }>(this.log, {
      vendor: 'openai-realtime',
      url: CLIENT_SECRETS,
      headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
      json: {
        expires_after: { anchor: 'created_at', seconds: Math.min(7200, Math.max(10, Math.round(opts.ttlSec))) },
        session: {
          type: 'realtime',
          model: this.model,
          audio: {
            input: { format: { type: 'audio/pcm', rate: 24000 } },
            output: { format: { type: 'audio/pcm', rate: 24000 }, voice },
          },
        },
      },
      timeoutMs: 8000,
    });
    if (!data || typeof data.value !== 'string' || !data.value) {
      throw new AppError(502, 'vendor_error', 'Voice service returned no token.');
    }
    return { token: data.value, model: this.model, voice, expiresAt: typeof data.expires_at === 'number' ? data.expires_at : 0 };
  }
}
