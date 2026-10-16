/**
 * Vapi (AI voice calls with a cloned voice): voice-call wishes (vapi-make-call), voice listing and cloning
 * (vapi-get-voices / vapi-upload-voice). Docs: https://docs.vapi.ai (POST /call, GET /call/:id, GET|POST /voice).
 *
 * Webhook authentication: for a transient assistant Vapi does not attach the org credential, so the shared secret
 * travels in `assistant.server.headers` and comes back as the `x-vapi-secret` header
 * (docs.vapi.ai/server-url/server-authentication, checked 2026-10). The production vapi-webhook accepted any POST
 * (audit finding 7); this server refuses calls it cannot authenticate, so the secret is required.
 */
import type { Env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

const BASE = 'https://api.vapi.ai';

export interface VapiCallRequest {
  phoneNumberId?: string | null;
  customer: { number: string; name?: string };
  assistant: Record<string, unknown>;
  metadata: Record<string, string>;
}

/** The parts of Vapi's Call object this server reads. */
export interface VapiCall {
  id: string;
  status?: string;
  endedReason?: string;
  startedAt?: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
  analysis?: { summary?: string; structuredData?: Record<string, unknown> };
  artifact?: { transcript?: string; messages?: Array<{ role?: string; message?: string }>; recordingUrl?: string };
  transcript?: string;
  summary?: string;
}

export interface VapiVoice {
  id: string;
  name: string;
  provider: string;
}

export class Vapi {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return !!(this.env.VAPI_API_KEY && this.env.VAPI_PHONE_NUMBER_ID && this.env.VAPI_WEBHOOK_SECRET);
  }

  private key(): string {
    if (!this.env.VAPI_API_KEY) throw unavailable('Voice calls are not available right now.');
    return this.env.VAPI_API_KEY;
  }

  /** Where Vapi posts call events, and the header that proves it is Vapi. */
  serverConfig(): { url: string; headers: Record<string, string> } {
    const url = new URL('/functions/v1/vapi-webhook', this.env.PUBLIC_URL);
    // The compat gateway requires an apikey on every function call; the anon key is public (it ships in the app).
    if (this.env.SUPABASE_ANON_KEY) url.searchParams.set('apikey', this.env.SUPABASE_ANON_KEY);
    return { url: url.toString(), headers: { 'x-vapi-secret': this.env.VAPI_WEBHOOK_SECRET ?? '' } };
  }

  /** Places an outbound call. Not retried: a lost response could otherwise ring the person twice. */
  async createCall(req: VapiCallRequest): Promise<VapiCall> {
    if (!this.configured) throw unavailable('Voice calls are not available right now.');
    const { data } = await vendorFetch<VapiCall>(this.log, {
      vendor: 'vapi',
      url: `${BASE}/call`,
      headers: { authorization: `Bearer ${this.key()}` },
      json: {
        phoneNumberId: req.phoneNumberId || this.env.VAPI_PHONE_NUMBER_ID,
        customer: req.customer,
        assistant: req.assistant,
        metadata: req.metadata,
      },
      timeoutMs: 15_000,
    });
    if (!data || typeof data.id !== 'string') throw new AppError(502, 'vendor_error', 'The phone service did not accept the call.');
    return data;
  }

  async getCall(id: string): Promise<VapiCall | null> {
    const { status, data } = await vendorFetch<VapiCall>(this.log, {
      vendor: 'vapi',
      url: `${BASE}/call/${encodeURIComponent(id)}`,
      headers: { authorization: `Bearer ${this.key()}` },
      timeoutMs: 10_000,
      retries: 2,
      okStatuses: [404],
    });
    return status === 404 ? null : data;
  }

  /** Every voice the Vapi organisation has (shared and users' clones alike: the caller filters). */
  async listVoices(): Promise<VapiVoice[]> {
    const { data } = await vendorFetch<unknown>(this.log, {
      vendor: 'vapi',
      url: `${BASE}/voice`,
      headers: { authorization: `Bearer ${this.key()}` },
      timeoutMs: 10_000,
      retries: 2,
    });
    if (!Array.isArray(data)) return [];
    const out: VapiVoice[] = [];
    for (const v of data as Array<Record<string, unknown>>) {
      const id = typeof v.id === 'string' ? v.id : typeof v.voiceId === 'string' ? v.voiceId : '';
      if (!id) continue;
      out.push({ id, name: typeof v.name === 'string' ? v.name : id, provider: typeof v.provider === 'string' ? v.provider : '11labs' });
    }
    return out;
  }

  /** Clones a voice from an audio file Vapi can fetch (production: POST /voice { provider, name, files: [url] }). */
  async createVoice(input: { provider: string; name: string; fileUrl: string }): Promise<{ id: string }> {
    const { data } = await vendorFetch<{ id?: string }>(this.log, {
      vendor: 'vapi',
      url: `${BASE}/voice`,
      headers: { authorization: `Bearer ${this.key()}` },
      json: { provider: input.provider, name: input.name, files: [input.fileUrl] },
      timeoutMs: 60_000,
    });
    if (!data?.id) throw new AppError(502, 'vendor_error', 'Voice cloning failed. Please try a clearer recording.');
    return { id: data.id };
  }
}
