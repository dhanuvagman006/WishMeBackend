/**
 * HeyGen. The app only needs the list of languages HeyGen voices speak (booking wizard). The deployed
 * heygen-get-languages derived it from `GET /v2/voices` (unique `language` values), so this does the same.
 * Avatar video generation, its poller and the (unsigned) heygen-webhook belong to the booking video pipeline,
 * not to the content functions.
 */
import type { Env } from '../config/env.js';
import { unavailable } from '../lib/errors.js';
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

const BASE = 'https://api.heygen.com';

interface VoicesResponse {
  data?: { voices?: Array<{ language?: unknown; locale?: unknown }> };
}

export class HeyGen {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return !!this.env.HEYGEN_API_KEY;
  }

  /** Unique language names of HeyGen's voices, sorted. */
  async voiceLanguages(): Promise<string[]> {
    if (!this.env.HEYGEN_API_KEY) throw unavailable('HeyGen is not configured');
    const { data } = await vendorFetch<VoicesResponse>(this.log, {
      vendor: 'heygen',
      url: `${BASE}/v2/voices`,
      headers: { 'x-api-key': this.env.HEYGEN_API_KEY, accept: 'application/json' },
      timeoutMs: 15_000,
      retries: 1,
    });
    const names = new Set<string>();
    for (const v of data?.data?.voices ?? []) {
      if (typeof v.language === 'string' && v.language.trim() && v.language.length <= 60) names.add(v.language.trim());
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }
}
