/**
 * Custom compat handlers for profiles and celebrity_applications, and the profile update guard.
 */
import { z } from 'zod';
import type { CompatResult, CustomArgs, PolicyCtx } from '../../compat/postgrest/policy.js';
import { pgrstError } from '../../compat/postgrest/parser.js';
import { randomBytes } from 'node:crypto';
import { AppError, forbidden } from '../../lib/errors.js';
import { phoneVariants, tenDigitMobile } from './phone.js';
import { cleanText, insertRow, represent } from './rows.js';

const invalid = (message: string) => new AppError(400, '22023', message);

// ── profiles: anonymous "forgot password by phone" ───────────────────────────────────────────────────────────

/**
 * GET profiles?select=email&phone=eq.<p>&limit=1 with the anon key (AuthContext.forgotPasswordByPhone). The real email
 * is never returned: when the number belongs to an account the reset email is sent from here, and every caller gets the
 * same kind of placeholder address, so the endpoint cannot be used to test which numbers have accounts. The app's
 * following POST /auth/v1/recover with the placeholder is a silent no-op. The work happens after the response is
 * decided, so timing does not reveal a match either.
 */
export async function anonPhoneLookup(a: CustomArgs): Promise<CompatResult | 'default'> {
  if (a.auth.kind !== 'anon') return 'default';
  const phoneParam = a.params.get('phone');
  if (!phoneParam || !phoneParam.startsWith('eq.') || (a.params.get('select') ?? '').replace(/\s/g, '') !== 'email') return 'default';
  const ten = tenDigitMobile(decodeURIComponent(phoneParam.slice(3)));
  const placeholder = `${randomBytes(12).toString('hex')}@reset.wishme.invalid`;

  if (ten) {
    const { deps } = a;
    void (async () => {
      try {
        await deps.limiter.hitAll('phone-reset', [
          { subject: `ip:${a.ip}`, rule: { limit: 10, windowSec: 3600 } },
          { subject: `phone:${ten}`, rule: { limit: 3, windowSec: 3600 } },
        ]);
      } catch {
        return; // over the limit: answer exactly as for any other number, send nothing
      }
      const variants = phoneVariants(ten);
      const rows = await deps.db<{ email: string | null }[]>`
        select email from public.profiles where phone = any(${variants}::text[]) order by created_at limit 1`;
      // Production's handle_new_user does not copy the sign-up phone to profiles (audit schema): it lives in the
      // auth user's metadata until the user saves it in Edit Profile.
      const email =
        rows[0]?.email ??
        (await deps.db<{ email: string | null }[]>`
          select email from auth.users where raw_user_meta_data ->> 'phone' = any(${variants}::text[]) and deleted_at is null limit 1`)[0]?.email;
      if (email) await deps.auth.recover(email, { ip: a.ip });
    })().catch((e: unknown) => a.deps.log.warn({ err: (e as Error).message }, 'phone reset lookup failed'));
  }

  const body = [{ email: placeholder }];
  return { status: 200, headers: { 'content-range': '0-0/*' }, body: a.single ? body[0] : body };
}

// ── profiles: plan PATCH after Razorpay ──────────────────────────────────────────────────────────────────────

/**
 * select-plan.tsx PATCHes { plan } after verify-razorpay-payment. The plan was already set by payment fulfilment, so
 * this only confirms it: 204 when the caller has a recent fulfilled plan_purchase order for that plan, else 403.
 */
export async function planPatch(a: CustomArgs): Promise<CompatResult | 'default'> {
  const body = a.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('plan' in body)) return 'default';
  const profileId = a.identity.profileId;
  if (a.auth.kind === 'anon' || !profileId) throw new AppError(401, '42501', 'permission denied: sign in required');
  if (Object.keys(body).length !== 1) throw forbidden('The plan is changed by payment and cannot be combined with other changes', '42501');
  const plan = (body as { plan: unknown }).plan;
  if (typeof plan !== 'string' || plan.length > 40) throw forbidden('Plans are activated by payment', '42501');
  const rows = await a.deps.db<{ ok: number }[]>`
    select 1 as ok from wishme.payment_orders
    where profile_id = ${profileId} and purpose = 'plan_purchase' and status = 'fulfilled'
      and lower(notes ->> 'plan_name') = ${plan.trim().toLowerCase()}
      and fulfilled_at > now() - interval '24 hours'
    limit 1`;
  if (!rows[0]) throw forbidden('Plans are activated by payment', '42501');
  if (!a.prefer.returnRepresentation) return { status: 204 };
  return represent(a, 'profiles', [profileId], 200);
}

// ── profiles: update guard ───────────────────────────────────────────────────────────────────────────────────

/**
 * edit-profile.tsx loads the profile with the anon key (so private fields arrive blank) and then saves the whole form.
 * Blank private fields therefore mean "unchanged", not "clear": they are dropped instead of overwriting real data.
 */
const KEEP_WHEN_BLANK = [
  'phone',
  'address',
  'bank_name',
  'bank_account_number',
  'bank_ifsc',
  'bank_account_holder_name',
  'aadhaar_number',
  'pan_number',
  'pan_document_url',
  // The same anon load leaves avatarUrl null, so Save sends avatar_url: null; an avatar cannot be removed through compat.
  'avatar_url',
  'first_name',
  'last_name',
];

const URL_RE = /^https?:\/\/[^\s]{1,1000}$/i;

export function checkProfileUpdate(row: Record<string, unknown>, _c: PolicyCtx): void {
  for (const k of KEEP_WHEN_BLANK) {
    const v = row[k];
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) delete row[k];
  }
  const text = (k: string, max: number) => {
    if (!(k in row)) return;
    if (typeof row[k] !== 'string') throw invalid(`Invalid ${k.replace(/_/g, ' ')}`);
    row[k] = cleanText(row[k], max);
  };
  text('first_name', 60);
  text('last_name', 60);
  text('address', 500);
  text('bank_name', 100);
  text('bank_account_holder_name', 100);
  if ('phone' in row) {
    const p = String(row.phone).trim();
    if (!tenDigitMobile(p) && !/^\+\d{8,15}$/.test(p.replace(/[\s-]/g, ''))) throw invalid('Invalid phone number');
    row.phone = p;
  }
  if ('aadhaar_number' in row) {
    const v = String(row.aadhaar_number).replace(/[\s-]/g, '');
    if (!/^\d{12}$/.test(v)) throw invalid('Invalid Aadhaar number');
    row.aadhaar_number = v;
  }
  if ('pan_number' in row) {
    const v = String(row.pan_number).trim().toUpperCase();
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(v)) throw invalid('Invalid PAN number');
    row.pan_number = v;
  }
  if ('bank_ifsc' in row) {
    const v = String(row.bank_ifsc).trim().toUpperCase();
    if (!IFSC_RE.test(v)) throw invalid('Invalid IFSC code');
    row.bank_ifsc = v;
  }
  if ('bank_account_number' in row) {
    const v = String(row.bank_account_number).replace(/[\s-]/g, '');
    if (!ACCOUNT_RE.test(v)) throw invalid('Invalid bank account number');
    row.bank_account_number = v;
  }
  for (const k of ['avatar_url', 'pan_document_url']) {
    if (k in row && (typeof row[k] !== 'string' || !URL_RE.test(row[k] as string))) throw invalid(`Invalid ${k.replace(/_/g, ' ')}`);
  }
  if ('profile_completion_percentage' in row) {
    const n = Number(row.profile_completion_percentage);
    if (!Number.isFinite(n)) delete row.profile_completion_percentage;
    else row.profile_completion_percentage = Math.min(100, Math.max(0, Math.round(n)));
  }
}

export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_RE = /^\d{6,18}$/;

// ── celebrity_applications ───────────────────────────────────────────────────────────────────────────────────

const opt = (max: number) => z.string().max(max).nullish();
const Application = z.object({
  first_name: z.string().trim().min(1).max(60),
  last_name: opt(60),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: opt(20),
  // CelebrityFormData (current) and CelebrityApplyData (legacy applyCelebrity) spell some fields differently.
  date_of_birth: opt(20),
  dob: opt(20),
  stage_name: opt(100),
  category: opt(60),
  bio: opt(2000),
  achievements: opt(2000),
  portfolio_link: opt(500),
  portfolio: opt(500),
  instagram: opt(200),
  youtube: opt(200),
  twitter: opt(200),
  social_media: z.record(z.string().max(200).nullable()).nullish(),
});

const SOCIAL_KEYS = ['instagram', 'youtube', 'twitter', 'tiktok', 'facebook', 'linkedin', 'website', 'other'];

function isoDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

/**
 * POST celebrity_applications, signed in (applyCelebrityWithAuth) or anonymous (legacy applyCelebrity, whose column set
 * fails against production today). Both shapes are mapped onto the real columns; status is always 'pending'. A repeat for an email with a pending application is
 * answered 201 without a second row (retries after a network error).
 */
export async function insertCelebrityApplication(a: CustomArgs): Promise<CompatResult> {
  const { deps } = a;
  const subject = a.auth.userId ? `u:${a.auth.userId}` : `ip:${a.ip}`;
  await deps.limiter.hit('celebrity-application', subject, { limit: 5, windowSec: 3600 }, 'Too many applications. Please try again later.');
  const body = Array.isArray(a.body) && a.body.length === 1 ? a.body[0] : a.body;
  const r = Application.safeParse(body);
  if (!r.success) {
    const i = r.error.issues[0];
    throw invalid(`Invalid ${i?.path.join('.') || 'application'}: ${i?.message ?? 'invalid value'}`);
  }
  const d = r.data;
  const social: Record<string, string> = {};
  for (const k of SOCIAL_KEYS) {
    const v = cleanText(d.social_media?.[k] ?? (d as Record<string, unknown>)[k], 200);
    if (v) social[k] = v;
  }
  const pending = await deps.db<{ id: string }[]>`
    select id::text from public.celebrity_applications where lower(email) = ${d.email} and status = 'pending' limit 1`;
  if (pending[0]) return { status: 201 };

  // Real columns (audit schema): no user_id and no legacy spellings, so CelebrityApplyData fields are mapped onto
  // date_of_birth / portfolio_link / social_media. last_name, phone, stage_name and bio are NOT NULL.
  const phone = cleanText(d.phone, 20);
  if (!phone || !/^\+?[\d\s-]{8,20}$/.test(phone)) throw invalid('Invalid phone');
  await insertRow(deps.db, deps.schema, 'celebrity_applications', {
    first_name: cleanText(d.first_name, 60),
    last_name: cleanText(d.last_name, 60) ?? '',
    email: d.email,
    phone,
    date_of_birth: isoDate(d.date_of_birth ?? d.dob),
    stage_name: cleanText(d.stage_name, 100) ?? '',
    category: cleanText(d.category, 60),
    bio: cleanText(d.bio, 2000) ?? '',
    achievements: cleanText(d.achievements, 2000),
    portfolio_link: cleanText(d.portfolio_link ?? d.portfolio, 500),
    social_media: social,
    status: 'pending',
  });
  return { status: 201 };
}

/**
 * The anonymous "check status" lookup: select=id,status&email=eq.<email>. Only id and status of the newest application
 * for that email, rate-limited per IP. Any other read falls through to the engine, which has no grants (403).
 */
export async function applicationStatusLookup(a: CustomArgs): Promise<CompatResult | 'default'> {
  const emailParam = a.params.get('email');
  const select = (a.params.get('select') ?? '').replace(/\s/g, '').split(',').filter(Boolean);
  if (!emailParam?.startsWith('eq.') || select.length === 0 || select.some((c) => c !== 'id' && c !== 'status')) return 'default';
  for (const k of a.params.keys()) {
    if (!['select', 'email', 'limit'].includes(k)) return 'default';
  }
  await a.deps.limiter.hit('application-status', a.ip, { limit: 20, windowSec: 3600 }, 'Too many requests. Please try again later.');
  const email = decodeURIComponent(emailParam.slice(3)).trim().toLowerCase();
  if (email.length > 254) throw pgrstError(400, '22023', 'Invalid email');
  const rows = await a.deps.db<{ id: string; status: string }[]>`
    select id::text, status from public.celebrity_applications where lower(email) = ${email} order by created_at desc limit 1`;
  const out = rows.map((r) => Object.fromEntries(select.map((c) => [c, r[c as 'id' | 'status']])));
  if (a.single) {
    if (out.length !== 1) throw pgrstError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${out.length} rows`);
    return { status: 200, body: out[0] };
  }
  return { status: 200, headers: { 'content-range': out.length ? '0-0/*' : '*/*' }, body: out };
}
