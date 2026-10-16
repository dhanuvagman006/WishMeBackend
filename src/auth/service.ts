/**
 * Sign-in, sign-up, refresh, sign-out, user updates and password recovery. The compat GoTrue routes and /api/v1/auth
 * both call this; only the response wrapping differs.
 */
import type { Env } from '../config/env.js';
import type { Db } from '../lib/db.js';
import { AppError, badRequest, conflict, unauthorized } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { RateLimiter } from '../lib/rate-limit.js';
import { pepperedHash, randomToken, uuid } from '../lib/crypto.js';
import { otpEmail, passwordChangedEmail, resetEmail, type Mailer } from '../vendors/email.js';
import type { TokenService } from './jwt.js';
import type { AuthResolver } from './context.js';
import { normaliseEmail, type Otps, type OtpPurpose } from './otp.js';
import { isBreachedPassword, type Passwords } from './passwords.js';
import type { RefreshTokens } from './refresh-tokens.js';
import { publicUser, type AuthUser, type UsersRepo } from './users-repo.js';

export interface ClientMeta {
  ip: string;
  userAgent?: string;
}

export interface Session {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: ReturnType<typeof publicUser>;
}

/** Metadata keys a client may set at sign-up or via PUT /user. Anything else (role escalation, balances) is dropped. */
const USER_META_ALLOWED = new Set(['first_name', 'last_name', 'firstName', 'lastName', 'phone', 'gender', 'member_since', 'referral_code', 'avatar_url']);
const SIGNUP_ROLES = new Set(['user', 'celebrity_pending']);

/** GoTrue-compatible invalid-credentials error (the app maps "invalid" to "Incorrect email or password"). */
const invalidCredentials = () =>
  new AppError(400, 'invalid_credentials', 'Invalid login credentials', { error: 'invalid_grant' });

export class AuthService {
  constructor(
    private readonly env: Env,
    private readonly db: Db,
    private readonly log: Logger,
    private readonly users: UsersRepo,
    private readonly passwords: Passwords,
    private readonly refresh: RefreshTokens,
    private readonly tokens: TokenService,
    private readonly otps: Otps,
    private readonly mailer: Mailer,
    private readonly limiter: RateLimiter,
    private readonly resolver: AuthResolver,
  ) {}

  // ── Sessions ────────────────────────────────────────────────────────────────────────────────────────────────

  private async sessionFor(user: AuthUser, refreshToken: string, familyId: string): Promise<Session> {
    const { token, expiresAt } = await this.tokens.signAccess({
      sub: user.id,
      role: 'authenticated',
      email: user.email ?? undefined,
      phone: user.phone ?? '',
      session_id: familyId,
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }],
      app_metadata: user.raw_app_meta_data ?? { provider: 'email', providers: ['email'] },
      user_metadata: user.raw_user_meta_data ?? {},
      is_anonymous: false,
    });
    return {
      access_token: token,
      token_type: 'bearer',
      expires_in: this.env.ACCESS_TOKEN_TTL_SEC,
      expires_at: expiresAt,
      refresh_token: refreshToken,
      user: publicUser(user),
    };
  }

  private async startFamily(user: AuthUser, meta: ClientMeta): Promise<Session> {
    const familyId = uuid();
    const issued = await this.db.begin(async (tx) => {
      const r = await this.refresh.issue(tx, user.id, familyId, meta);
      await this.users.mirrorSession(tx, familyId, user.id, meta);
      return r;
    });
    return this.sessionFor(user, issued.token, familyId);
  }

  private assertActive(user: AuthUser | null): asserts user is AuthUser {
    if (!user || user.deleted_at) throw invalidCredentials();
    if (user.banned_until && user.banned_until.getTime() > Date.now()) {
      throw new AppError(400, 'user_banned', 'User is banned');
    }
  }

  async signInWithPassword(rawEmail: unknown, password: unknown, meta: ClientMeta): Promise<Session> {
    const email = normaliseEmail(rawEmail);
    if (typeof password !== 'string' || password.length === 0 || password.length > 1024) throw invalidCredentials();
    await this.limiter.hitAll('login', [
      { subject: `email:${email}`, rule: { limit: 10, windowSec: 900 } },
      { subject: `ip:${meta.ip}`, rule: { limit: 60, windowSec: 900 } },
    ], 'Too many sign-in attempts. Please wait a few minutes and try again.');

    const user = await this.users.findByEmail(email);
    const ok = await this.passwords.verify(user?.encrypted_password, password);
    if (!ok || !user) throw invalidCredentials();
    this.assertActive(user);

    if (user.encrypted_password && this.passwords.needsRehash(user.encrypted_password)) {
      await this.users.setPassword(user.id, await this.passwords.hash(password)).catch((e: unknown) =>
        this.log.warn({ err: (e as Error).message, userId: user.id }, 'password rehash failed'),
      );
    }
    await this.users.touchSignIn(user.id);
    return this.startFamily(user, meta);
  }

  async refreshSession(refreshToken: unknown, meta: ClientMeta): Promise<Session> {
    if (typeof refreshToken !== 'string' || refreshToken.length < 8 || refreshToken.length > 300) {
      throw new AppError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    }
    await this.limiter.hit('refresh', meta.ip, { limit: 120, windowSec: 60 });

    // A refresh token issued by Supabase before the switch: accepted once, then the user is on our sessions.
    if (!this.refresh.isOurs(refreshToken)) {
      const userId = await this.db.begin((tx) => this.users.consumeSupabaseRefreshToken(tx, refreshToken));
      if (!userId) throw new AppError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      const user = await this.users.findById(userId);
      this.assertActive(user);
      this.log.info({ userId }, 'migrated a Supabase session');
      return this.startFamily(user, meta);
    }

    const result = await this.db.begin((tx) => this.refresh.rotate(tx, refreshToken, meta));
    if (typeof result === 'string') {
      if (result === 'reused') this.log.warn({ ip: meta.ip }, 'refresh token reuse detected; family revoked');
      throw new AppError(
        400,
        result === 'expired' ? 'refresh_token_expired' : 'refresh_token_not_found',
        result === 'expired' ? 'Invalid Refresh Token: Refresh Token Expired' : 'Invalid Refresh Token: Already Used',
      );
    }
    const user = await this.users.findById(result.userId);
    if (!user || user.deleted_at || (user.banned_until && user.banned_until.getTime() > Date.now())) {
      await this.refresh.revokeFamily(this.db, result.familyId, 'user_inactive');
      throw new AppError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    }
    return this.sessionFor(user, result.issued.token, result.familyId);
  }

  async signOut(userId: string, sessionId: string | null, scope: 'local' | 'global' = 'local'): Promise<void> {
    await this.db.begin(async (tx) => {
      if (scope === 'global') {
        const families = await this.refresh.revokeAllForUser(tx, userId, 'signed_out');
        await this.users.dropSessions(tx, families);
      } else if (sessionId) {
        await this.refresh.revokeFamily(tx, sessionId, 'signed_out');
        await this.users.dropSessions(tx, [sessionId]);
      }
    });
  }

  // ── Sign-up with email OTP ─────────────────────────────────────────────────────────────────────────────────

  async sendOtp(rawEmail: unknown, purpose: OtpPurpose, meta: ClientMeta): Promise<void> {
    const email = normaliseEmail(rawEmail);
    if (purpose === 'signup' && (await this.users.emailExists(email))) {
      throw conflict('An account with this email already exists. Please sign in instead.', 'email_exists');
    }
    const code = await this.otps.create(email, purpose, meta.ip);
    await this.mailer.send({ to: email, ...otpEmail(code, Math.round(this.env.OTP_TTL_SEC / 60), purpose) });
  }

  async verifyOtp(rawEmail: unknown, otp: unknown, purpose: OtpPurpose, meta: ClientMeta): Promise<void> {
    const email = normaliseEmail(rawEmail);
    await this.otps.verify(email, purpose, otp, meta.ip);
  }

  async checkNewPassword(password: unknown): Promise<string> {
    if (typeof password !== 'string') throw new AppError(422, 'weak_password', 'Password is required');
    if (password.length < this.env.PASSWORD_MIN_LENGTH) {
      throw new AppError(422, 'weak_password', `Password should be at least ${this.env.PASSWORD_MIN_LENGTH} characters.`);
    }
    if (password.length > 128) throw new AppError(422, 'weak_password', 'Password should be at most 128 characters.');
    if (this.env.PASSWORD_BREACH_CHECK && (await isBreachedPassword(password, this.log))) {
      throw new AppError(422, 'weak_password', 'This password has appeared in a data breach. Please choose a different one.');
    }
    return password;
  }

  async signUp(body: { email?: unknown; password?: unknown; data?: unknown }, meta: ClientMeta): Promise<Session> {
    const email = normaliseEmail(body.email);
    const password = await this.checkNewPassword(body.password);
    await this.limiter.hit('signup-ip', meta.ip, { limit: 20, windowSec: 3600 });

    const raw = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
    const userMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (USER_META_ALLOWED.has(k) && (typeof v === 'string' || v === null)) userMeta[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    }
    userMeta.role = typeof raw.role === 'string' && SIGNUP_ROLES.has(raw.role) ? raw.role : 'user';
    userMeta.wallet_balance = 0;
    userMeta.member_since ??= new Date().toISOString().slice(0, 10);
    userMeta.email = email;
    userMeta.email_verified = true;

    const passwordHash = await this.passwords.hash(password);
    const id = uuid();
    const user = await this.db.begin(async (tx) => {
      // Serialise sign-ups for the same address so two racing requests cannot both pass the existence check.
      await tx`select pg_advisory_xact_lock(hashtext(${`signup:${email}`}))`;
      if (await this.users.findByEmail(email, tx)) throw new AppError(422, 'user_already_exists', 'User already registered');
      const consumed = await this.otps.consumeVerified(email, 'signup', tx);
      if (!consumed) {
        throw new AppError(400, 'otp_required', 'Email verification is required. Please verify the code sent to your email first.');
      }
      return this.users.create(tx, { id, email, passwordHash, userMeta, phone: null });
    });
    this.log.info({ userId: user.id, role: userMeta.role }, 'user signed up');
    await this.resolver.forgetIdentity(user.id);
    return this.startFamily(user, meta);
  }

  // ── Profile and password changes ───────────────────────────────────────────────────────────────────────────

  async getUser(userId: string): Promise<ReturnType<typeof publicUser>> {
    const user = await this.users.findById(userId);
    if (!user) throw unauthorized('User not found', 'user_not_found');
    return publicUser(user);
  }

  async updateUser(
    userId: string,
    sessionId: string | null,
    body: { password?: unknown; data?: unknown; email?: unknown },
  ): Promise<ReturnType<typeof publicUser>> {
    if (body.email !== undefined) throw badRequest('Changing the email address is not supported yet', 'email_change_unsupported');
    if (body.data !== undefined) {
      const raw = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (USER_META_ALLOWED.has(k) && k !== 'referral_code' && (typeof v === 'string' || v === null)) patch[k] = v;
      }
      if (Object.keys(patch).length) await this.users.mergeUserMeta(userId, patch);
    }
    if (body.password !== undefined) {
      await this.limiter.hit('password-change', userId, { limit: 5, windowSec: 3600 });
      const password = await this.checkNewPassword(body.password);
      const hash = await this.passwords.hash(password);
      await this.db.begin(async (tx) => {
        await this.users.setPassword(userId, hash, tx);
        // Every other device is signed out; the current one stays signed in.
        const families = await this.refresh.revokeAllForUser(tx, userId, 'password_changed', sessionId ?? undefined);
        await this.users.dropSessions(tx, families);
      });
      const user = await this.users.findById(userId);
      if (user?.email) {
        await this.mailer.send({ to: user.email, ...passwordChangedEmail() }).catch((e: unknown) =>
          this.log.warn({ err: (e as Error).message }, 'password-changed email failed'),
        );
      }
    }
    return this.getUser(userId);
  }

  // ── Password recovery (link to a page this server hosts) ───────────────────────────────────────────────────

  /** Always resolves (no account enumeration). Sends a single-use link valid for 30 minutes. */
  async recover(rawEmail: unknown, meta: ClientMeta): Promise<void> {
    const email = normaliseEmail(rawEmail);
    await this.limiter.hitAll('recover', [
      { subject: `email:${email}`, rule: { limit: 3, windowSec: 3600 } },
      { subject: `ip:${meta.ip}`, rule: { limit: 20, windowSec: 3600 } },
    ]);
    const user = await this.users.findByEmail(email);
    if (!user || user.deleted_at) return;
    const token = randomToken(32);
    await this.db`
      insert into wishme.password_resets (user_id, token_hash, expires_at, ip)
      values (${user.id}, ${pepperedHash(this.env.AUTH_PEPPER, `reset:${token}`)}, now() + interval '30 minutes', ${meta.ip})`;
    const link = `${this.env.PUBLIC_URL.replace(/\/$/, '')}/auth/reset#token=${encodeURIComponent(token)}`;
    await this.mailer.send({ to: email, ...resetEmail(link, 30) });
  }

  async completeReset(token: unknown, newPassword: unknown, meta: ClientMeta): Promise<void> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw badRequest('This reset link is invalid or has expired.', 'reset_invalid');
    await this.limiter.hit('reset-complete', meta.ip, { limit: 20, windowSec: 3600 });
    const password = await this.checkNewPassword(newPassword);
    const hash = await this.passwords.hash(password);
    const userId = await this.db.begin(async (tx) => {
      const rows = await tx<{ user_id: string }[]>`
        update wishme.password_resets set used_at = now()
        where token_hash = ${pepperedHash(this.env.AUTH_PEPPER, `reset:${token}`)} and used_at is null and expires_at > now()
        returning user_id`;
      const uid = rows[0]?.user_id;
      if (!uid) throw badRequest('This reset link is invalid or has expired.', 'reset_invalid');
      await this.users.setPassword(uid, hash, tx);
      const families = await this.refresh.revokeAllForUser(tx, uid, 'password_reset');
      await this.users.dropSessions(tx, families);
      return uid;
    });
    const user = await this.users.findById(userId);
    if (user?.email) await this.mailer.send({ to: user.email, ...passwordChangedEmail() }).catch(() => {});
  }
}
