/**
 * Access tokens. Two signing modes:
 *  - supabase-hs256 (transition): HS256 with the Supabase project's JWT secret, so a token issued here is also accepted
 *    by the Supabase routes we still proxy to (PostgREST, edge functions, Storage).
 *  - eddsa (after cutover): Ed25519 keys only this server holds; previous public keys stay valid during rotation.
 * Verification accepts whatever the current mode can check, plus legacy HS256 while SUPABASE_JWT_SECRET is set, so
 * tokens issued before the switch keep working until they expire.
 */
import { SignJWT, importPKCS8, importSPKI, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';

type KeyLike = Awaited<ReturnType<typeof importPKCS8>>;
import { createPublicKey } from 'node:crypto';
import type { Env } from '../config/env.js';
import { unauthorized } from '../lib/errors.js';

export interface AccessClaims extends JWTPayload {
  sub?: string;
  role: 'anon' | 'authenticated' | 'service_role' | string;
  aud?: string | string[];
  email?: string;
  phone?: string;
  session_id?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  aal?: string;
  is_anonymous?: boolean;
}

export interface TokenService {
  signAccess(claims: Omit<AccessClaims, 'iat' | 'exp' | 'iss'>): Promise<{ token: string; expiresAt: number }>;
  verify(token: string): Promise<AccessClaims>;
  jwks(): Promise<{ keys: unknown[] }>;
}

interface VerifyKey {
  kid?: string;
  alg: 'EdDSA' | 'HS256';
  key: KeyLike | Uint8Array;
}

export async function createTokenService(env: Env): Promise<TokenService> {
  const hsSecret = env.SUPABASE_JWT_SECRET ? new TextEncoder().encode(env.SUPABASE_JWT_SECRET) : null;
  let signer: { alg: 'EdDSA' | 'HS256'; key: KeyLike | Uint8Array; kid?: string };
  const verifyKeys: VerifyKey[] = [];
  const publicJwks: unknown[] = [];

  if (env.JWT_SIGNING === 'eddsa') {
    const pem = env.JWT_PRIVATE_KEY!.replace(/\\n/g, '\n');
    const priv = await importPKCS8(pem, 'EdDSA');
    signer = { alg: 'EdDSA', key: priv, kid: env.JWT_KEY_ID };
    const pubPem = createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString();
    const pub = await importSPKI(pubPem, 'EdDSA');
    verifyKeys.push({ kid: env.JWT_KEY_ID, alg: 'EdDSA', key: pub });
    publicJwks.push({ ...createPublicKey(pem).export({ format: 'jwk' }), kid: env.JWT_KEY_ID, alg: 'EdDSA', use: 'sig' });
    if (env.JWT_PREVIOUS_PUBLIC_KEYS) {
      const prev = JSON.parse(env.JWT_PREVIOUS_PUBLIC_KEYS) as Array<{ kid: string; pem: string }>;
      for (const p of prev) {
        const k = await importSPKI(p.pem.replace(/\\n/g, '\n'), 'EdDSA');
        verifyKeys.push({ kid: p.kid, alg: 'EdDSA', key: k });
        publicJwks.push({ ...createPublicKey(p.pem.replace(/\\n/g, '\n')).export({ format: 'jwk' }), kid: p.kid, alg: 'EdDSA', use: 'sig' });
      }
    }
  } else {
    signer = { alg: 'HS256', key: hsSecret! };
  }
  if (hsSecret) verifyKeys.push({ alg: 'HS256', key: hsSecret });

  const issuer = `${env.PUBLIC_URL.replace(/\/$/, '')}/auth/v1`;

  return {
    async signAccess(claims) {
      const now = Math.floor(Date.now() / 1000);
      const exp = now + env.ACCESS_TOKEN_TTL_SEC;
      const header: { alg: string; typ: string; kid?: string } = { alg: signer.alg, typ: 'JWT' };
      if (signer.kid) header.kid = signer.kid;
      const token = await new SignJWT({ aud: 'authenticated', ...claims })
        .setProtectedHeader(header)
        .setIssuer(issuer)
        .setIssuedAt(now)
        .setExpirationTime(exp)
        .sign(signer.key);
      return { token, expiresAt: exp };
    },

    async verify(token) {
      let header: { alg?: string; kid?: string };
      try {
        header = decodeProtectedHeader(token);
      } catch {
        throw unauthorized('Invalid JWT', 'bad_jwt');
      }
      const candidates = verifyKeys.filter((k) => k.alg === header.alg && (!header.kid || !k.kid || k.kid === header.kid));
      if (candidates.length === 0) throw unauthorized('Invalid JWT', 'bad_jwt');
      let lastErr: unknown;
      for (const k of candidates) {
        try {
          const { payload } = await jwtVerify(token, k.key, { algorithms: [k.alg], clockTolerance: 30 });
          const claims = payload as AccessClaims;
          if (claims.role !== 'anon' && claims.role !== 'authenticated' && claims.role !== 'service_role') {
            throw unauthorized('Invalid JWT role', 'bad_jwt');
          }
          if (claims.role === 'authenticated' && !claims.sub) throw unauthorized('Invalid JWT: missing sub', 'bad_jwt');
          return claims;
        } catch (e) {
          lastErr = e;
        }
      }
      const expired = (lastErr as { code?: string })?.code === 'ERR_JWT_EXPIRED';
      throw unauthorized(expired ? 'JWT expired' : 'Invalid JWT', expired ? 'jwt_expired' : 'bad_jwt');
    },

    async jwks() {
      return { keys: publicJwks };
    },
  };
}
