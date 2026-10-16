/**
 * Gemini Live: ephemeral tokens for the app's own Live socket, and a server-side Live socket for phone calls.
 *
 * Tokens: the app opens Google's Live WebSocket itself (…BidiGenerateContentConstrained?access_token=<token>), so the
 * server only mints a short-lived, single-use token with its key. REST: POST
 * https://generativelanguage.googleapis.com/v1beta/auth_tokens (x-goog-api-key) with
 * { uses, expireTime, newSessionExpireTime } → { name }; `name` is the token. Production (functions/voice-token in the
 * supabase audit) mints exactly this, unconstrained: one session start within 60 s, usable for 30 minutes so the app
 * can resume the session.
 *
 * Calls: the phone-call bridge talks to the Live API directly over
 * wss://…/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent with the key in the
 * x-goog-api-key header (never in the URL, so it cannot end up in a log line).
 */
import WebSocket from 'ws';
import type { Env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export interface LiveToken {
  token: string;
  /** Bare model id (no "models/" prefix): the app builds `models/${model}` itself. */
  model: string;
}

export class GeminiLive {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return !!this.env.GEMINI_API_KEY;
  }

  get model(): string {
    return this.env.GEMINI_LIVE_MODEL.replace(/^models\//, '');
  }

  private key(): string {
    if (!this.env.GEMINI_API_KEY) throw unavailable('Voice assistant is not configured');
    return this.env.GEMINI_API_KEY;
  }

  /** Single-use token: one session start within `startWithinSec`, usable for `ttlSec` (resumption included). */
  async mint(opts: { ttlSec: number; startWithinSec: number }): Promise<LiveToken> {
    const key = this.key();
    const now = Date.now();
    const { data } = await vendorFetch<{ name?: string }>(this.log, {
      vendor: 'gemini-live',
      url: `${BASE}/auth_tokens`,
      headers: { 'x-goog-api-key': key },
      json: {
        uses: 1,
        expireTime: new Date(now + opts.ttlSec * 1000).toISOString(),
        newSessionExpireTime: new Date(now + opts.startWithinSec * 1000).toISOString(),
      },
      timeoutMs: 6000,
    });
    if (!data || typeof data.name !== 'string' || !data.name) {
      throw new AppError(502, 'vendor_error', 'Voice service returned no token.');
    }
    return { token: data.name, model: this.model };
  }

  /** Opens a server-side Live session (used by the phone-call bridge). The caller sends the setup message. */
  connect(): WebSocket {
    return new WebSocket(LIVE_WS, { headers: { 'x-goog-api-key': this.key() }, handshakeTimeout: 8000, maxPayload: 8 * 1024 * 1024 });
  }
}
