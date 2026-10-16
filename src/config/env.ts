/**
 * All configuration, read once at startup and validated. The process refuses to start with a missing or malformed
 * value rather than running with a guessed default; secrets never have defaults.
 */
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : ['true', '1', 'yes'].includes(v)));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    PORT: int(3000, 1, 65535),
    HOST: z.string().default('0.0.0.0'),
    /** Public base URL of this API, e.g. https://api.wishme.today (used in emails, relay URLs, storage URLs). */
    PUBLIC_URL: z.string().url(),
    /** Comma-separated origins allowed by CORS for browser clients (the native app sends no Origin). */
    CORS_ORIGINS: csv,
    /** Number of trusted proxies in front of the app (Caddy = 1). Needed for correct client IPs in rate limits. */
    TRUST_PROXY_HOPS: int(1, 0, 5),

    // ── Database ────────────────────────────────────────────────────────────────────────────────────────────
    DB_MODE: z.enum(['shared', 'standalone']).default('shared'),
    DATABASE_URL: z.string().min(1),
    /** A direct (non-pooled) connection for LISTEN/NOTIFY. Defaults to DATABASE_URL. */
    DATABASE_URL_DIRECT: z.string().optional(),
    DB_POOL_MAX: int(15, 1, 200),
    /** false when DATABASE_URL points at a transaction-mode pooler (Supavisor :6543, PgBouncer). */
    DB_PREPARE: bool(true),
    DB_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
    DB_STATEMENT_TIMEOUT_MS: int(8000, 100, 600_000),
    /** Apply Supabase's own RLS under our policies (SET LOCAL ROLE + request.jwt.claims). */
    DB_RLS_PASSTHROUGH: bool(true),

    // ── Redis ───────────────────────────────────────────────────────────────────────────────────────────────
    REDIS_URL: z.string().optional(),
    REDIS_PREFIX: z.string().default('wm'),

    // ── Supabase (upstream for proxying, and the transition signing secret) ──────────────────────────────
    SUPABASE_URL: z.string().url().optional(),
    /** The anon key the app ships with. Requests must present it (or a valid user token) as `apikey`. */
    SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_JWT_SECRET: z.string().optional(),
    COMPAT_DEFAULT_MODE: z.enum(['local', 'proxy']).default('proxy'),
    /** JSON object of overrides, e.g. {"auth":"local","rest:profiles":"local","functions:send-email-otp":"local"}. */
    ROUTE_MODES: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (!v) return {} as Record<string, 'local' | 'proxy'>;
        try {
          const parsed = JSON.parse(v) as unknown;
          const r = z.record(z.enum(['local', 'proxy'])).safeParse(parsed);
          if (!r.success) throw new Error(r.error.message);
          return r.data;
        } catch (e) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ROUTE_MODES is not valid JSON: ${(e as Error).message}` });
          return z.NEVER;
        }
      }),
    PROXY_TIMEOUT_MS: int(30_000, 1000, 300_000),

    // ── Auth ────────────────────────────────────────────────────────────────────────────────────────────────
    JWT_SIGNING: z.enum(['supabase-hs256', 'eddsa']).default('supabase-hs256'),
    /** PKCS8 PEM Ed25519 private key (eddsa mode). Newlines may be written as \n. */
    JWT_PRIVATE_KEY: z.string().optional(),
    JWT_KEY_ID: z.string().default('wm-1'),
    /** Extra public keys still accepted during a key rotation: JSON array of {kid, pem}. */
    JWT_PREVIOUS_PUBLIC_KEYS: z.string().optional(),
    JWT_ISSUER: z.string().default('wishme'),
    ACCESS_TOKEN_TTL_SEC: int(3600, 60, 86_400),
    REFRESH_TOKEN_TTL_DAYS: int(60, 1, 365),
    /** Seconds during which a just-rotated refresh token may be presented again (network retries). */
    REFRESH_REUSE_GRACE_SEC: int(10, 0, 120),
    /** Server-side pepper mixed into OTP and token hashes. 32+ random bytes, base64. */
    AUTH_PEPPER: z.string().min(32),
    OTP_TTL_SEC: int(600, 60, 3600),
    OTP_MAX_ATTEMPTS: int(5, 1, 20),
    /** How long a verified sign-up OTP authorises the following /auth/v1/signup call. */
    OTP_SIGNUP_WINDOW_SEC: int(900, 60, 3600),
    PASSWORD_MIN_LENGTH: int(8, 6, 128),
    /** Reject passwords found in the Have I Been Pwned range API (k-anonymity, no password leaves the server). */
    PASSWORD_BREACH_CHECK: bool(true),
    /** Auth user ids with admin rights (comma separated) until an admin role exists in the database. */
    ADMIN_USER_IDS: csv,

    // ── Email ───────────────────────────────────────────────────────────────────────────────────────────────
    EMAIL_PROVIDER: z.enum(['log', 'smtp', 'resend']).default('log'),
    EMAIL_FROM: z.string().default('WishMe <no-reply@wishme.today>'),
    SMTP_URL: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),

    // ── Vendors (all optional; a function whose vendor is not configured answers 503) ─────────────────────
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    B2_ENDPOINT: z.string().optional(),
    B2_REGION: z.string().default('us-west-004'),
    B2_KEY_ID: z.string().optional(),
    B2_APP_KEY: z.string().optional(),
    B2_BUCKET: z.string().default('wishmetoday'),
    /** Public download base for public objects, e.g. https://f005.backblazeb2.com/file/wishmetoday */
    B2_PUBLIC_BASE: z.string().optional(),
    B2_PRIVATE_BUCKET: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_LIVE_MODEL: z.string().default('gemini-live-2.5-flash-preview'),
    GEMINI_TEXT_MODEL: z.string().default('gemini-2.5-flash'),
    GEMINI_IMAGE_MODEL: z.string().default('gemini-2.5-flash-image'),
    SARVAM_API_KEY: z.string().optional(),
    ELEVENLABS_API_KEY: z.string().optional(),
    VAPI_API_KEY: z.string().optional(),
    VAPI_PHONE_NUMBER_ID: z.string().optional(),
    VAPI_WEBHOOK_SECRET: z.string().optional(),
    HEYGEN_API_KEY: z.string().optional(),
    TBO_ENV: z.enum(['test', 'live']).default('test'),
    TBO_CLIENT_ID: z.string().optional(),
    TBO_USERNAME: z.string().optional(),
    TBO_PASSWORD: z.string().optional(),
    TBO_HOTEL_USERNAME: z.string().optional(),
    TBO_HOTEL_PASSWORD: z.string().optional(),
    WHATSAPP_PROVIDER: z.enum(['none', 'meta']).default('none'),
    WHATSAPP_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WEB_SEARCH_PROVIDER: z.enum(['none', 'gemini']).default('gemini'),

    // ── Operations ──────────────────────────────────────────────────────────────────────────────────────────
    SENTRY_DSN: z.string().optional(),
    METRICS_TOKEN: z.string().optional(),
    /** Minimum and recommended app versions returned by GET /api/v1/config (force-update gate). */
    APP_MIN_VERSION: z.string().default('1.0.0'),
    APP_RECOMMENDED_VERSION: z.string().default('1.0.0'),
    RATE_LIMIT_PER_MIN: int(300, 10, 100_000),
    BODY_LIMIT_MB: int(10, 1, 200),
    UPLOAD_LIMIT_MB: int(50, 1, 500),
  })
  .superRefine((e, ctx) => {
    const need = (cond: boolean, key: string, why: string) => {
      if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required ${why}` });
    };
    if (e.JWT_SIGNING === 'supabase-hs256') {
      need(!!e.SUPABASE_JWT_SECRET && e.SUPABASE_JWT_SECRET.length >= 32, 'SUPABASE_JWT_SECRET', 'when JWT_SIGNING=supabase-hs256 (32+ chars)');
    } else {
      need(!!e.JWT_PRIVATE_KEY, 'JWT_PRIVATE_KEY', 'when JWT_SIGNING=eddsa');
    }
    const usesProxy = e.COMPAT_DEFAULT_MODE === 'proxy' || Object.values(e.ROUTE_MODES).includes('proxy');
    if (usesProxy) need(!!e.SUPABASE_URL, 'SUPABASE_URL', 'when any route group is in proxy mode');
    if (e.DB_MODE === 'shared') need(!!e.SUPABASE_ANON_KEY, 'SUPABASE_ANON_KEY', 'in shared mode (the app sends it)');
    if (e.EMAIL_PROVIDER === 'smtp') need(!!e.SMTP_URL, 'SMTP_URL', 'when EMAIL_PROVIDER=smtp');
    if (e.EMAIL_PROVIDER === 'resend') need(!!e.RESEND_API_KEY, 'RESEND_API_KEY', 'when EMAIL_PROVIDER=resend');
    if (e.NODE_ENV === 'production') {
      need(!!e.REDIS_URL, 'REDIS_URL', 'in production (rate limits, queues and caches must be shared by replicas)');
      need(e.EMAIL_PROVIDER !== 'log', 'EMAIL_PROVIDER', 'to be a real provider in production');
      need(e.DB_SSL !== 'disable' || /@(postgres|localhost|127\.0\.0\.1)[:/]/.test(e.DATABASE_URL), 'DB_SSL',
        'to be enabled when the database is not on the local Docker network');
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Parses process.env once. Throws a readable error listing every problem. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

/** For tests: forget the cached env so a changed process.env is read again. */
export function resetEnvCache(): void {
  cached = null;
}
