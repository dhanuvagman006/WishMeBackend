import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anon, bearer, bootTest, lastOtp, profileIdOf, signUp, type TestCtx } from '../helpers.js';

let t: TestCtx;

beforeAll(async () => {
  t = await bootTest({ env: { REFRESH_REUSE_GRACE_SEC: '0' } });
});
afterAll(async () => {
  await t.close();
});

const PASSWORD = 'Str0ng-and-l0ng-pass';

describe('email OTP sign-up (the app flow, unchanged)', () => {
  it('sends a code, rejects a wrong one with "Invalid", and accepts the right one', async () => {
    const email = 'otp-user@example.com';
    const send = await t.app.inject({ method: 'POST', url: '/functions/v1/send-email-otp', headers: anon(), payload: { email } });
    expect(send.statusCode).toBe(200);
    const bad = await t.app.inject({ method: 'POST', url: '/functions/v1/verify-email-otp', headers: anon(), payload: { email, otp: '000000' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/invalid/i);
    const good = await t.app.inject({ method: 'POST', url: '/functions/v1/verify-email-otp', headers: anon(), payload: { email, otp: lastOtp(t.mailer, email) } });
    expect(good.statusCode).toBe(200);
  });

  it('answers 429 with retryAfter when codes are requested too quickly', async () => {
    const email = 'cooldown@example.com';
    await t.app.inject({ method: 'POST', url: '/functions/v1/send-email-otp', headers: anon(), payload: { email } });
    const again = await t.app.inject({ method: 'POST', url: '/functions/v1/send-email-otp', headers: anon(), payload: { email } });
    expect(again.statusCode).toBe(429);
    expect(again.json().retryAfter).toBeGreaterThan(0);
  });

  it('refuses /auth/v1/signup unless the OTP for that email was verified first', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/v1/signup',
      headers: anon(),
      payload: { email: 'skipper@example.com', password: PASSWORD, data: { first_name: 'Skip' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_description).toMatch(/verif/i);
  });

  it('creates the user and profile, ignores role escalation and returns a GoTrue session', async () => {
    const s = await signUp(t, 'new-user@example.com', PASSWORD, { first_name: 'Asha', role: 'admin', wallet_balance: 99999 });
    expect(s.access_token).toBeTruthy();
    expect(s.refresh_token).toMatch(/^wm1_/);
    expect(s.user.email).toBe('new-user@example.com');
    const meta = (s.user as unknown as { user_metadata: Record<string, unknown> }).user_metadata;
    expect(meta.role).toBe('user');
    expect(meta.wallet_balance).toBe(0);
    await expect(profileIdOf(t, s.user.id)).resolves.toBeTruthy();
  });

  it('answers 409 to send-email-otp for an email that already has an account', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/functions/v1/send-email-otp', headers: anon(), payload: { email: 'new-user@example.com' } });
    expect(res.statusCode).toBe(409);
  });
});

describe('sessions', () => {
  it('signs in with a password and rejects a wrong one with "Invalid login credentials"', async () => {
    const ok = await t.app.inject({
      method: 'POST',
      url: '/auth/v1/token?grant_type=password',
      headers: anon(),
      payload: { email: 'NEW-USER@example.com ', password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    const bad = await t.app.inject({ method: 'POST', url: '/auth/v1/token?grant_type=password', headers: anon(), payload: { email: 'new-user@example.com', password: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error_description).toMatch(/invalid/i);
  });

  it('rotates refresh tokens and revokes the family when an old one is replayed', async () => {
    const s = await signUp(t, 'rotate@example.com');
    const r1 = await t.app.inject({ method: 'POST', url: '/auth/v1/token?grant_type=refresh_token', headers: anon(), payload: { refresh_token: s.refresh_token } });
    expect(r1.statusCode).toBe(200);
    const next = r1.json().refresh_token as string;
    expect(next).not.toBe(s.refresh_token);
    const replay = await t.app.inject({ method: 'POST', url: '/auth/v1/token?grant_type=refresh_token', headers: anon(), payload: { refresh_token: s.refresh_token } });
    expect(replay.statusCode).toBe(400);
    // The whole family is now revoked, including the token issued by the legitimate refresh.
    const after = await t.app.inject({ method: 'POST', url: '/auth/v1/token?grant_type=refresh_token', headers: anon(), payload: { refresh_token: next } });
    expect(after.statusCode).toBe(400);
  });

  it('returns the user, merges allowed metadata and drops the rest', async () => {
    const s = await signUp(t, 'meta@example.com');
    const put = await t.app.inject({
      method: 'PUT',
      url: '/auth/v1/user',
      headers: bearer(s.access_token),
      payload: { data: { gender: 'female', role: 'admin' } },
    });
    expect(put.statusCode).toBe(200);
    const user = put.json();
    expect(user.user_metadata.gender).toBe('female');
    expect(user.user_metadata.role).toBe('user');
  });

  it('logs out by revoking the refresh family', async () => {
    const s = await signUp(t, 'logout@example.com');
    const out = await t.app.inject({ method: 'POST', url: '/auth/v1/logout', headers: bearer(s.access_token) });
    expect(out.statusCode).toBe(204);
    const r = await t.app.inject({ method: 'POST', url: '/auth/v1/token?grant_type=refresh_token', headers: anon(), payload: { refresh_token: s.refresh_token } });
    expect(r.statusCode).toBe(400);
  });

  it('requires the apikey header like Supabase does', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/auth/v1/token?grant_type=password', payload: { email: 'x@example.com', password: 'y' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('password recovery through the hosted page', () => {
  it('mails a single-use link that sets a new password and signs other devices out', async () => {
    const s = await signUp(t, 'forgot@example.com');
    const rec = await t.app.inject({ method: 'POST', url: '/auth/v1/recover', headers: anon(), payload: { email: 'forgot@example.com' } });
    expect(rec.statusCode).toBe(200);
    const mail = [...t.mailer.sent].reverse().find((m) => m.to === 'forgot@example.com' && /reset/i.test(m.subject))!;
    const token = decodeURIComponent(mail.text.match(/token=([^\s]+)/)![1]!);
    const page = await t.app.inject({ method: 'GET', url: '/auth/reset' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    const done = await t.app.inject({ method: 'POST', url: '/auth/reset', payload: { token, password: 'An0ther-l0ng-password' } });
    expect(done.statusCode).toBe(200);
    const reuse = await t.app.inject({ method: 'POST', url: '/auth/reset', payload: { token, password: 'Third-l0ng-password' } });
    expect(reuse.statusCode).toBe(400);
    const old = await t.app.inject({ method: 'POST', url: '/auth/v1/token?grant_type=refresh_token', headers: anon(), payload: { refresh_token: s.refresh_token } });
    expect(old.statusCode).toBe(400);
    const login = await t.app.inject({ method: 'POST', url: '/auth/v1/token?grant_type=password', headers: anon(), payload: { email: 'forgot@example.com', password: 'An0ther-l0ng-password' } });
    expect(login.statusCode).toBe(200);
  });

  it('answers the same way for unknown emails (no account enumeration)', async () => {
    const rec = await t.app.inject({ method: 'POST', url: '/auth/v1/recover', headers: anon(), payload: { email: 'nobody@example.com' } });
    expect(rec.statusCode).toBe(200);
  });
});
