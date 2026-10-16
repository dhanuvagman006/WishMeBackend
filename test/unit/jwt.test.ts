import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createTokenService } from '../../src/auth/jwt.js';
import { loadEnv } from '../../src/config/env.js';

const base = {
  ...process.env,
  PUBLIC_URL: 'https://api.example.test',
  DATABASE_URL: 'postgres://x@localhost/x',
  AUTH_PEPPER: 'p'.repeat(40),
  SUPABASE_ANON_KEY: 'anon',
  COMPAT_DEFAULT_MODE: 'local',
};

describe('access tokens', () => {
  it('signs HS256 with the Supabase secret in transition mode, with the claims Supabase expects', async () => {
    const env = loadEnv({ ...base, JWT_SIGNING: 'supabase-hs256', SUPABASE_JWT_SECRET: 's'.repeat(40) });
    const svc = await createTokenService(env);
    const { token } = await svc.signAccess({ sub: 'u1', role: 'authenticated', session_id: 'f1' });
    const claims = await svc.verify(token);
    expect(claims).toMatchObject({ sub: 'u1', role: 'authenticated', aud: 'authenticated', session_id: 'f1', iss: 'https://api.example.test/auth/v1' });
  });

  it('signs Ed25519 after cutover, still accepts legacy HS256 tokens while the secret is set, and publishes the JWKS', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const secret = 'h'.repeat(40);
    const env = loadEnv({ ...base, JWT_SIGNING: 'eddsa', JWT_PRIVATE_KEY: pem, SUPABASE_JWT_SECRET: secret });
    const svc = await createTokenService(env);
    const { token } = await svc.signAccess({ sub: 'u2', role: 'authenticated' });
    expect(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()).alg).toBe('EdDSA');
    expect((await svc.verify(token)).sub).toBe('u2');
    const legacy = await new SignJWT({ role: 'authenticated', sub: 'u3' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(new TextEncoder().encode(secret));
    expect((await svc.verify(legacy)).sub).toBe('u3');
    expect((await svc.jwks()).keys).toHaveLength(1);
  });

  it('rejects expired, tampered, alg-none and role-less tokens', async () => {
    const secret = 's'.repeat(40);
    const env = loadEnv({ ...base, JWT_SIGNING: 'supabase-hs256', SUPABASE_JWT_SECRET: secret });
    const svc = await createTokenService(env);
    const key = new TextEncoder().encode(secret);
    const expired = await new SignJWT({ role: 'authenticated', sub: 'u' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime(Math.floor(Date.now() / 1000) - 3600).sign(key);
    await expect(svc.verify(expired)).rejects.toMatchObject({ code: 'jwt_expired' });
    const { token } = await svc.signAccess({ sub: 'u', role: 'authenticated' });
    const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
    await expect(svc.verify(tampered)).rejects.toMatchObject({ status: 401 });
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"role":"service_role"}').toString('base64url')}.`;
    await expect(svc.verify(none)).rejects.toMatchObject({ status: 401 });
    const roleless = await new SignJWT({ sub: 'u' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(key);
    await expect(svc.verify(roleless)).rejects.toMatchObject({ status: 401 });
  });
});
