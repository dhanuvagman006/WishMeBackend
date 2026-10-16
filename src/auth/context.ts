/**
 * Who is calling. Every request gets an AuthContext built from its `apikey` and `Authorization` headers (or, for
 * WebSockets, the query string and the join payload). Identity keys are resolved here once, from the token, so no
 * route ever trusts an id sent by the client for ownership:
 *  - userId      auth.users.id (the JWT `sub`)
 *  - profileId   public.profiles.id where user_id = userId (most app tables key on this)
 *  - celebrityIds public.celebrities.id where profile_id = profileId
 */
import type { Env } from '../config/env.js';
import type { Db } from '../lib/db.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { Kv } from '../lib/redis.js';
import { safeEqual } from '../lib/crypto.js';
import type { AccessClaims, TokenService } from './jwt.js';

export type CallerKind = 'anon' | 'user' | 'service';

export interface Identity {
  profileId: string | null;
  celebrityIds: string[];
  profileRole: string | null;
}

export interface AuthContext {
  kind: CallerKind;
  userId: string | null;
  email: string | null;
  sessionId: string | null;
  claims: AccessClaims;
  /** The raw bearer (user token or anon key); forwarded as-is when a route is proxied. */
  bearer: string | null;
  isAdmin: boolean;
  identity(): Promise<Identity>;
}

const ANON_CLAIMS: AccessClaims = { role: 'anon' };

export class AuthResolver {
  constructor(
    private readonly env: Env,
    private readonly tokens: TokenService,
    private readonly db: Db,
    private readonly kv: Kv,
  ) {}

  /** Validates the `apikey` header: the app's anon key, or any token this server can verify. */
  async checkApiKey(apikey: string | undefined): Promise<void> {
    if (!apikey) throw unauthorized('No API key found in request', 'no_api_key');
    if (this.env.SUPABASE_ANON_KEY && safeEqual(apikey, this.env.SUPABASE_ANON_KEY)) return;
    try {
      await this.tokens.verify(apikey);
    } catch {
      throw unauthorized('Invalid API key', 'invalid_api_key');
    }
  }

  /** Builds the caller context. A bearer equal to the anon key (what the app sends when signed out) means anon. */
  async resolve(bearer: string | null | undefined): Promise<AuthContext> {
    const token = bearer?.trim() || null;
    if (!token || (this.env.SUPABASE_ANON_KEY && safeEqual(token, this.env.SUPABASE_ANON_KEY))) {
      return this.anon(token);
    }
    const claims = await this.tokens.verify(token);
    if (claims.role === 'anon') return this.anon(token);
    if (claims.role === 'service_role') {
      return this.build('service', claims, token);
    }
    return this.build('user', claims, token);
  }

  anon(bearer: string | null): AuthContext {
    return {
      kind: 'anon',
      userId: null,
      email: null,
      sessionId: null,
      claims: ANON_CLAIMS,
      bearer,
      isAdmin: false,
      identity: async () => ({ profileId: null, celebrityIds: [], profileRole: null }),
    };
  }

  private build(kind: CallerKind, claims: AccessClaims, bearer: string): AuthContext {
    const userId = claims.sub ?? null;
    let cached: Promise<Identity> | null = null;
    return {
      kind,
      userId,
      email: typeof claims.email === 'string' ? claims.email : null,
      sessionId: typeof claims.session_id === 'string' ? claims.session_id : null,
      claims,
      bearer,
      isAdmin: kind === 'service' || (!!userId && this.env.ADMIN_USER_IDS.includes(userId)),
      identity: () => (cached ??= userId ? this.loadIdentity(userId) : Promise.resolve({ profileId: null, celebrityIds: [], profileRole: null })),
    };
  }

  /** Cached 60 s per user; invalidated when a profile or celebrity row is created for the user. */
  async loadIdentity(userId: string): Promise<Identity> {
    const key = `ident:${userId}`;
    const hit = await this.kv.get(key);
    if (hit) return JSON.parse(hit) as Identity;
    let identity: Identity = { profileId: null, celebrityIds: [], profileRole: null };
    try {
      const prof = await this.db<{ id: string; role: string | null }[]>`
        select id, role::text as role from public.profiles where user_id = ${userId} limit 1`;
      const profileId = prof[0]?.id ?? null;
      const celebs = profileId
        ? await this.db<{ id: string }[]>`select id from public.celebrities where profile_id = ${profileId}`
        : [];
      identity = { profileId, celebrityIds: celebs.map((c) => c.id), profileRole: prof[0]?.role ?? null };
    } catch (e) {
      // Tables missing in a bare development database: behave as a user without a profile.
      if ((e as { code?: string }).code !== '42P01' && (e as { code?: string }).code !== '42703') throw e;
    }
    // Do not cache a missing profile for long: sign-up creates it moments later.
    await this.kv.set(key, JSON.stringify(identity), identity.profileId ? 60 : 3);
    return identity;
  }

  async forgetIdentity(userId: string): Promise<void> {
    await this.kv.del(`ident:${userId}`);
  }
}

export function requireUser(ctx: AuthContext): asserts ctx is AuthContext & { userId: string } {
  if (ctx.kind === 'anon' || !ctx.userId) throw unauthorized('Authentication required');
}

export function requireAdmin(ctx: AuthContext): void {
  requireUser(ctx);
  if (!ctx.isAdmin) throw forbidden('Admin only');
}

/** The claims Supabase RLS expects in request.jwt.claims for this caller. */
export function dbClaims(ctx: AuthContext): Record<string, unknown> {
  if (ctx.kind === 'anon') return { role: 'anon' };
  return { ...ctx.claims, role: ctx.kind === 'service' ? 'service_role' : 'authenticated' };
}
