/**
 * Email one-time codes for sign-up and password reset.
 *
 * The error messages are part of the app contract: AuthContext matches "expir", "invalid" and "used"/"already" in
 * them, and send-email-otp's 409 / 429 (+ retryAfter) / 400 statuses drive the sign-up screen.
 *
 * Unlike the old edge functions, verification is bound to sign-up: verifying marks the challenge verified, and
 * /auth/v1/signup only succeeds if it can consume a verified, unused challenge for the same email within
 * OTP_SIGNUP_WINDOW_SEC. The app does not change for this.
 */
import type { Env } from '../config/env.js';
import type { Db } from '../lib/db.js';
import { AppError, badRequest } from '../lib/errors.js';
import { pepperedHash, randomDigits, safeEqual } from '../lib/crypto.js';
import type { RateLimiter } from '../lib/rate-limit.js';

export type OtpPurpose = 'signup' | 'reset';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normaliseEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('Invalid email address', 'invalid_email');
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw badRequest('Invalid email address', 'invalid_email');
  return email;
}

export class Otps {
  constructor(
    private readonly db: Db,
    private readonly env: Env,
    private readonly limiter: RateLimiter,
  ) {}

  private hash(email: string, purpose: OtpPurpose, code: string) {
    return pepperedHash(this.env.AUTH_PEPPER, `otp:${purpose}:${email}:${code}`);
  }

  /** Creates a challenge and returns the plaintext code for the mailer. Enforces cooldown and hourly caps. */
  async create(email: string, purpose: OtpPurpose, ip: string): Promise<string> {
    await this.limiter.hit(`otp-cooldown:${purpose}`, email, { limit: 1, windowSec: 60 }, 'Please wait before requesting another code');
    await this.limiter.hitAll(`otp-send:${purpose}`, [
      { subject: `email:${email}`, rule: { limit: 5, windowSec: 3600 } },
      { subject: `ip:${ip}`, rule: { limit: 30, windowSec: 3600 } },
    ]);
    const code = randomDigits(6);
    await this.db.begin(async (tx) => {
      // Only the newest code is valid.
      await tx`
        update wishme.otp_challenges set expires_at = least(expires_at, now())
        where email = ${email} and purpose = ${purpose} and verified_at is null and expires_at > now()`;
      await tx`
        insert into wishme.otp_challenges (email, purpose, code_hash, expires_at, ip)
        values (${email}, ${purpose}, ${this.hash(email, purpose, code)},
                now() + make_interval(secs => ${this.env.OTP_TTL_SEC}), ${ip})`;
    });
    return code;
  }

  /** Verifies a code. Idempotent after success until the challenge is consumed. */
  async verify(email: string, purpose: OtpPurpose, code: unknown, ip: string): Promise<void> {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
      throw new AppError(400, 'otp_invalid', 'Invalid OTP. Please check the code and try again.');
    }
    await this.limiter.hit('otp-verify-ip', ip, { limit: 60, windowSec: 3600 });
    const clean = code.trim();
    await this.db.begin(async (tx) => {
      const rows = await tx<
        { id: string; code_hash: string; attempts: number; expires_at: Date; verified_at: Date | null; consumed_at: Date | null }[]
      >`
        select id, code_hash, attempts, expires_at, verified_at, consumed_at
        from wishme.otp_challenges
        where email = ${email} and purpose = ${purpose}
        order by created_at desc limit 1 for update`;
      const c = rows[0];
      if (!c) throw new AppError(400, 'otp_invalid', 'Invalid OTP. Please request a new code.');
      if (c.consumed_at) throw new AppError(400, 'otp_used', 'This OTP has already been used. Please request a new one.');
      if (c.verified_at) {
        if (safeEqual(c.code_hash, this.hash(email, purpose, clean))) return;
        throw new AppError(400, 'otp_used', 'This OTP has already been used. Please request a new one.');
      }
      if (c.expires_at.getTime() <= Date.now()) {
        throw new AppError(400, 'otp_expired', 'OTP has expired. Please request a new one.');
      }
      if (c.attempts >= this.env.OTP_MAX_ATTEMPTS) {
        throw new AppError(400, 'otp_expired', 'Too many attempts: this OTP has expired. Please request a new one.');
      }
      if (!safeEqual(c.code_hash, this.hash(email, purpose, clean))) {
        await tx`update wishme.otp_challenges set attempts = attempts + 1 where id = ${c.id}`;
        throw new AppError(400, 'otp_invalid', 'Invalid OTP. Please check the code and try again.');
      }
      await tx`update wishme.otp_challenges set verified_at = now() where id = ${c.id}`;
    });
  }

  /** Consumes a verified challenge for the next step (sign-up or reset). Returns false when there is none. */
  async consumeVerified(email: string, purpose: OtpPurpose, tx: Db | import('../lib/db.js').Tx = this.db): Promise<boolean> {
    const rows = await tx`
      update wishme.otp_challenges set consumed_at = now()
      where id = (
        select id from wishme.otp_challenges
        where email = ${email} and purpose = ${purpose} and verified_at is not null and consumed_at is null
          and verified_at > now() - make_interval(secs => ${this.env.OTP_SIGNUP_WINDOW_SEC})
        order by verified_at desc limit 1
        for update skip locked)
      returning id`;
    return rows.length > 0;
  }

  async purgeOld(): Promise<number> {
    const rows = await this.db`delete from wishme.otp_challenges where created_at < now() - interval '2 days' returning 1`;
    return rows.length;
  }
}
