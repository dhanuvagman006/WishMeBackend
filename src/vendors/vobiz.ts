/**
 * Vobiz: Indian telephony. AI calls (ai-call-start, reminder calls) and immediate celebrity-voice calls ring through
 * Vobiz; the conversation itself runs on our side over a bidirectional media stream (see domains/voice/vobiz-call.ts).
 *
 * API as the production functions use it (supabase audit 2026-10-16: functions/vapi-celebrity-call, _shared/vobiz.ts
 * callers): POST https://api.vobiz.ai/api/v1/Account/<auth id>/Call/ with headers X-Auth-ID / X-Auth-Token and
 * { from, to (digits only), answer_url, answer_method, ring_url, ring_method, hangup_url, hangup_method, ring_timeout,
 * time_limit } → { request_uuid | call_uuid | id }. The answer URL returns VobizXML (<Stream>, <Record>, <Play>).
 *
 * Configuration: VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, VOBIZ_PHONE_NUMBER (src/config/env.ts; secret names from the audit).
 */
import type { Env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

const BASE = 'https://api.vobiz.ai/api/v1';

export interface VobizConfig {
  authId: string;
  authToken: string;
  from: string;
}

export function vobizConfig(env: Env): VobizConfig | null {
  const authId = env.VOBIZ_AUTH_ID;
  const authToken = env.VOBIZ_AUTH_TOKEN;
  const from = env.VOBIZ_PHONE_NUMBER;
  if (!authId || !authToken || !from) return null;
  return { authId, authToken, from };
}

export interface PlaceCall {
  to: string;
  answerUrl: string;
  ringUrl: string;
  hangupUrl: string;
  /** Vobiz hangs up after this many seconds. */
  timeLimitSeconds: number;
  ringTimeoutSeconds?: number;
}

const digits = (n: string) => n.replace(/\D/g, '');

export class Vobiz {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return vobizConfig(this.env) !== null;
  }

  private config(): VobizConfig {
    const c = vobizConfig(this.env);
    if (!c) throw unavailable('AI calling is not set up yet.');
    return c;
  }

  /** Places an outbound call. Never retried: a lost response must not ring the person twice. */
  async placeCall(p: PlaceCall): Promise<{ id: string }> {
    const c = this.config();
    const { data } = await vendorFetch<{ request_uuid?: string; call_uuid?: string; id?: string; message?: string } | string>(this.log, {
      vendor: 'vobiz',
      url: `${BASE}/Account/${encodeURIComponent(c.authId)}/Call/`,
      headers: { 'X-Auth-ID': c.authId, 'X-Auth-Token': c.authToken },
      json: {
        from: digits(c.from),
        to: digits(p.to),
        // GET callbacks: the compat gateway parses POST bodies as JSON, and Vobiz posts forms.
        answer_url: p.answerUrl,
        answer_method: 'GET',
        ring_url: p.ringUrl,
        ring_method: 'GET',
        hangup_url: p.hangupUrl,
        hangup_method: 'GET',
        ring_timeout: String(p.ringTimeoutSeconds ?? 45),
        time_limit: String(p.timeLimitSeconds),
      },
      timeoutMs: 20_000,
    });
    const body = typeof data === 'object' && data ? data : {};
    const id = String(body.request_uuid ?? body.call_uuid ?? body.id ?? '');
    if (!id) throw new AppError(502, 'vendor_error', 'The phone service did not accept the call.');
    return { id };
  }
}
