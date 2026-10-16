/**
 * TBO (Travel Boutique Online / Tek Travels): the Air API (JSON over REST, session token) and the Hotel API
 * (JSON over REST, HTTP Basic). Credentials are agency-level and can issue real, paid tickets, so they live only here.
 *
 * - Endpoints switch on TBO_ENV (test | live).
 * - The Air token is cached in the shared KV store until shortly before TBO expires it (end of the IST day), and is
 *   refreshed once when TBO reports an invalid session.
 * - Logs carry the method, HTTP status, TBO status/error code and timing only. Request and response bodies (names,
 *   passport, PAN, phone, email, dates of birth) are never logged; `redactTbo` is the only way a body may reach a
 *   log line, at debug level.
 * - Vendor error bodies are dropped from thrown errors for the same reason.
 *
 * Test hosts are the ones the deployed tbo-flights / tbo-hotels functions call (Supabase audit, 16 Oct 2026; those
 * functions only ever used the test hosts). ASSUMPTION: the live hosts are TBO's published production hosts and must
 * be confirmed against the agency's onboarding sheet before TBO_ENV=live.
 *
 * TBO_END_USER_IP is the agency's whitelisted IP, as the deployed functions used.
 */
import type { Env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';
import type { Kv } from '../lib/redis.js';

export const TBO_ENDPOINTS = {
  test: {
    auth: 'http://Sharedapi.tektravels.com/SharedData.svc/rest/Authenticate',
    airSearch: 'http://api.tektravels.com/BookingEngineService_Air/AirService.svc/rest',
    airBook: 'http://api.tektravels.com/BookingEngineService_Air/AirService.svc/rest',
    hotel: 'https://affiliate.tektravels.com/HotelAPI',
  },
  live: {
    auth: 'https://api.travelboutiqueonline.com/SharedAPI/SharedData.svc/rest/Authenticate',
    airSearch: 'https://tboapi.travelboutiqueonline.com/AirAPI_V10/AirService.svc/rest',
    airBook: 'https://booking.travelboutiqueonline.com/AirAPI_V10/AirService.svc/rest',
    hotel: 'https://affiliate.tbotechnology.in/HotelAPI',
  },
} as const;

export function configuredEndUserIp(env: Env): string | undefined {
  const v = env.TBO_END_USER_IP;
  return v && /^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? v : undefined;
}

export type AirMethod = 'Search' | 'FareRule' | 'FareQuote' | 'SSR' | 'Book' | 'Ticket' | 'GetBookingDetails' | 'ReleasePNRRequest';
export type HotelMethod = 'CityList' | 'TBOHotelCodeList' | 'Search' | 'PreBook' | 'Book' | 'BookingDetail';

/** Air methods served by the booking host (the rest by the search host). */
const BOOKING_METHODS = new Set<AirMethod>(['Book', 'Ticket', 'GetBookingDetails', 'ReleasePNRRequest']);
/** Calls that may be retried on a network error: they do not create anything. */
const IDEMPOTENT_AIR = new Set<AirMethod>(['Search', 'FareRule', 'FareQuote', 'SSR', 'GetBookingDetails']);

// "Invalid / expired token" on the Air API (as the deployed function handles it).
const INVALID_SESSION_CODES = new Set([6]);

export interface TboError {
  ErrorCode?: number;
  ErrorMessage?: string;
}

export interface AirEnvelope<T = Record<string, unknown>> {
  Response?: T & { ResponseStatus?: number; Error?: TboError; TraceId?: string };
}

/** Raised when TBO answered and said no: nothing was booked. */
export class TboRejected extends AppError {
  constructor(
    public readonly method: string,
    public readonly tboCode: number | string | undefined,
    message: string,
  ) {
    super(422, 'tbo_rejected', message, { method, tboCode });
  }
}

/**
 * Raised when the outcome is unknown (timeout, connection reset, 5xx on a booking call): the booking or ticket may
 * exist at TBO. Money is not refunded automatically for these.
 */
export class TboUncertain extends AppError {
  constructor(public readonly method: string) {
    super(504, 'tbo_uncertain', 'The airline system did not confirm in time.', { method });
  }
}

const PII_KEY = /passport|pan|contact|phone|mobile|email|first.?name|last.?name|^name$|dateofbirth|dob|address|gst|nationality|city|title|customer/i;

/** Deep copy with personal fields masked; the only form in which a TBO body may be logged. */
export function redactTbo(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactTbo(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(TokenId|Password|UserName|ClientId)$/i.test(k)) out[k] = '[secret]';
      else if (PII_KEY.test(k) && (typeof v !== 'object' || v === null)) out[k] = '[redacted]';
      else out[k] = redactTbo(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Seconds until 23:45 IST today (TBO tokens lapse at the end of the IST day), clamped to [5 min, 20 h]. */
export function tokenTtlSec(now = new Date()): number {
  const istMs = now.getTime() + 5.5 * 3600 * 1000;
  const ist = new Date(istMs);
  const cutoff = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 23, 45, 0);
  const sec = Math.floor((cutoff - istMs) / 1000);
  return Math.min(Math.max(sec, 300), 20 * 3600);
}

export class Tbo {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
    private readonly kv: Kv,
  ) {}

  private get urls() {
    return TBO_ENDPOINTS[this.env.TBO_ENV];
  }

  get airConfigured(): boolean {
    return !!(this.env.TBO_CLIENT_ID && this.env.TBO_USERNAME && this.env.TBO_PASSWORD);
  }

  get hotelConfigured(): boolean {
    return !!(this.env.TBO_HOTEL_USERNAME && this.env.TBO_HOTEL_PASSWORD);
  }

  private tokenKey(): string {
    return `tbo:${this.env.TBO_ENV}:air-token`;
  }

  private async token(endUserIp: string, fresh = false): Promise<string> {
    if (!this.airConfigured) throw unavailable('Flight booking is not configured');
    if (!fresh) {
      const hit = await this.kv.get(this.tokenKey());
      if (hit) return hit;
    }
    const started = Date.now();
    const { data } = await vendorFetch<{ Status?: number; TokenId?: string; Error?: TboError }>(this.log, {
      vendor: 'tbo',
      url: this.urls.auth,
      json: { ClientId: this.env.TBO_CLIENT_ID, UserName: this.env.TBO_USERNAME, Password: this.env.TBO_PASSWORD, EndUserIp: endUserIp },
      timeoutMs: 20_000,
      retries: 1,
    }).catch((e: unknown) => {
      throw strip(e, 'Authenticate');
    });
    if (!data?.TokenId || (data.Status !== undefined && data.Status !== 1)) {
      this.log.error({ vendor: 'tbo', method: 'Authenticate', tboCode: data?.Error?.ErrorCode, ms: Date.now() - started }, 'tbo authentication failed');
      throw unavailable('Flight booking is temporarily unavailable');
    }
    await this.kv.set(this.tokenKey(), data.TokenId, tokenTtlSec());
    return data.TokenId;
  }

  /**
   * One Air API call. Returns the inner `Response` object when TBO reports success (ResponseStatus 1); throws
   * TboRejected when TBO says no, TboUncertain when a booking call's outcome is unknown.
   */
  async air<T = Record<string, unknown>>(
    method: AirMethod,
    body: Record<string, unknown>,
    ctx: { endUserIp: string; timeoutMs?: number },
  ): Promise<NonNullable<AirEnvelope<T>['Response']>> {
    const base = BOOKING_METHODS.has(method) ? this.urls.airBook : this.urls.airSearch;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const tokenId = await this.token(ctx.endUserIp, attempt > 1);
      const started = Date.now();
      let data: AirEnvelope<T> | null;
      try {
        ({ data } = await vendorFetch<AirEnvelope<T>>(this.log, {
          vendor: 'tbo',
          url: `${base}/${method}`,
          json: { ...body, EndUserIp: ctx.endUserIp, TokenId: tokenId },
          timeoutMs: ctx.timeoutMs ?? 30_000,
          retries: IDEMPOTENT_AIR.has(method) ? 1 : 0,
        }));
      } catch (e) {
        if (!IDEMPOTENT_AIR.has(method) && isAmbiguous(e)) throw new TboUncertain(method);
        throw strip(e, method);
      }
      const r = data?.Response;
      const code = r?.Error?.ErrorCode;
      this.log.info(
        { vendor: 'tbo', method, responseStatus: r?.ResponseStatus, tboCode: code, traceId: r?.TraceId ?? body.TraceId, ms: Date.now() - started },
        'tbo call',
      );
      this.log.debug({ vendor: 'tbo', method, request: redactTbo(body), response: redactTbo(r) }, 'tbo call detail');
      if (r && r.ResponseStatus === 1 && (!code || code === 0)) return r;
      if (attempt === 1 && typeof code === 'number' && INVALID_SESSION_CODES.has(code)) {
        await this.kv.del(this.tokenKey());
        continue;
      }
      if (!r) {
        if (!IDEMPOTENT_AIR.has(method)) throw new TboUncertain(method);
        throw new AppError(502, 'tbo_error', 'The airline system returned an empty answer. Please try again.');
      }
      throw new TboRejected(method, code, airMessage(method, r.Error?.ErrorMessage));
    }
    throw new AppError(502, 'tbo_error', 'The airline system is unavailable. Please try again.');
  }

  /** One Hotel API call (HTTP Basic). Returns the body when Status.Code is 200. */
  async hotel<T extends { Status?: { Code?: number; Description?: string } }>(
    method: HotelMethod,
    body: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.hotelConfigured) throw unavailable('Hotel booking is not configured');
    const url = `${this.urls.hotel}/${method}`;
    const idempotent = method !== 'Book';
    const auth = Buffer.from(`${this.env.TBO_HOTEL_USERNAME}:${this.env.TBO_HOTEL_PASSWORD}`).toString('base64');
    const started = Date.now();
    let data: T | null;
    try {
      ({ data } = await vendorFetch<T>(this.log, {
        vendor: 'tbo-hotel',
        url,
        headers: { authorization: `Basic ${auth}` },
        json: body,
        timeoutMs: opts.timeoutMs ?? 30_000,
        retries: idempotent ? 1 : 0,
      }));
    } catch (e) {
      if (!idempotent && isAmbiguous(e)) throw new TboUncertain(method);
      throw strip(e, method);
    }
    const code = data?.Status?.Code;
    this.log.info({ vendor: 'tbo-hotel', method, tboCode: code, ms: Date.now() - started }, 'tbo call');
    this.log.debug({ vendor: 'tbo-hotel', method, request: redactTbo(body), response: redactTbo(data) }, 'tbo call detail');
    if (data && code === 200) return data;
    if (!data && !idempotent) throw new TboUncertain(method);
    throw new TboRejected(method, code, hotelMessage(method, data?.Status?.Description));
  }
}

/** Network errors, timeouts and 5xx: the request may have reached TBO. */
function isAmbiguous(e: unknown): boolean {
  if (!(e instanceof AppError)) return true;
  if (e.code === 'vendor_unreachable') return true;
  const status = (e.details as { status?: number } | undefined)?.status;
  return e.code === 'vendor_error' && (status === undefined || status >= 500);
}

function strip(e: unknown, method: string): AppError {
  if (e instanceof AppError) {
    if (e.code === 'vendor_unreachable') return new AppError(504, 'vendor_unreachable', 'The travel system is not responding. Please try again.');
    return new AppError(502, 'tbo_error', 'The travel system could not be reached. Please try again.', { method });
  }
  return new AppError(502, 'tbo_error', 'The travel system could not be reached. Please try again.', { method });
}

/** TBO error messages are written for agents; keep them (they explain fare and seat problems) but bound them. */
function airMessage(method: AirMethod, msg?: string): string {
  const m = (msg ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (m) return m;
  return method === 'Search' ? 'No flights could be found. Please try again.' : 'The airline could not complete this request. Please search again.';
}

function hotelMessage(method: HotelMethod, msg?: string): string {
  const m = (msg ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return m || (method === 'Search' ? 'No hotels could be found. Please try again.' : 'The hotel could not complete this request. Please try again.');
}
