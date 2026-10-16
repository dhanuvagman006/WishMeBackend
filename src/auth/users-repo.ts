/**
 * Credentials live in auth.users (Supabase's table during the transition, a compatible copy after cutover). In shared
 * mode the rows written here must stay usable by Supabase GoTrue, so inserts fill the columns GoTrue scans as non-null
 * strings and add the matching auth.identities and auth.sessions rows. Column sets differ between GoTrue versions, so
 * they are discovered once by introspection instead of assumed.
 */
import type { Db, Queryable } from '../lib/db.js';

export interface AuthUser {
  id: string;
  email: string | null;
  phone: string | null;
  encrypted_password: string | null;
  email_confirmed_at: Date | null;
  last_sign_in_at: Date | null;
  raw_app_meta_data: Record<string, unknown> | null;
  raw_user_meta_data: Record<string, unknown> | null;
  created_at: Date | null;
  updated_at: Date | null;
  banned_until: Date | null;
  deleted_at: Date | null;
}

const USER_COLS = [
  'id',
  'email',
  'phone',
  'encrypted_password',
  'email_confirmed_at',
  'last_sign_in_at',
  'raw_app_meta_data',
  'raw_user_meta_data',
  'created_at',
  'updated_at',
  'banned_until',
  'deleted_at',
] as const;

/** GoTrue scans these as Go strings; NULL makes Supabase sign-in fail with "converting NULL to string". */
const GOTRUE_EMPTY_STRING_COLS = [
  'confirmation_token',
  'recovery_token',
  'email_change_token_new',
  'email_change_token_current',
  'email_change',
  'phone_change',
  'phone_change_token',
  'reauthentication_token',
];

interface Shape {
  users: Set<string>;
  identities: Set<string> | null;
  sessions: Set<string> | null;
  refreshTokens: Set<string> | null;
}

export class UsersRepo {
  private shape: Shape | null = null;

  constructor(
    private readonly db: Db,
    private readonly mode: 'shared' | 'standalone',
  ) {}

  private async columns(table: string): Promise<Set<string> | null> {
    const rows = await this.db<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'auth' and table_name = ${table}`;
    return rows.length ? new Set(rows.map((r) => r.column_name)) : null;
  }

  async describe(): Promise<Shape> {
    if (!this.shape) {
      const users = await this.columns('users');
      if (!users) throw new Error('auth.users does not exist: run migrations (standalone) or check DATABASE_URL (shared)');
      this.shape = {
        users,
        identities: await this.columns('identities'),
        sessions: await this.columns('sessions'),
        refreshTokens: await this.columns('refresh_tokens'),
      };
    }
    return this.shape;
  }

  async findByEmail(email: string, q: Queryable = this.db): Promise<AuthUser | null> {
    const rows = await q<AuthUser[]>`
      select ${q(USER_COLS as unknown as string[])} from auth.users
      where lower(email) = lower(${email}) and deleted_at is null
      order by created_at asc limit 1`;
    return rows[0] ?? null;
  }

  async findById(id: string, q: Queryable = this.db): Promise<AuthUser | null> {
    const rows = await q<AuthUser[]>`
      select ${q(USER_COLS as unknown as string[])} from auth.users where id = ${id} and deleted_at is null limit 1`;
    return rows[0] ?? null;
  }

  async emailExists(email: string): Promise<boolean> {
    const rows = await this.db`select 1 from auth.users where lower(email) = lower(${email}) and deleted_at is null limit 1`;
    return rows.length > 0;
  }

  /** Creates a confirmed email/password user (the OTP already proved the address). Runs inside the caller's tx. */
  async create(
    tx: Queryable,
    input: { id: string; email: string; passwordHash: string; userMeta: Record<string, unknown>; phone?: string | null },
  ): Promise<AuthUser> {
    const shape = await this.describe();
    const now = new Date();
    const appMeta = { provider: 'email', providers: ['email'] };
    const row: Record<string, unknown> = {
      id: input.id,
      email: input.email.toLowerCase(),
      encrypted_password: input.passwordHash,
      email_confirmed_at: now,
      raw_app_meta_data: appMeta,
      raw_user_meta_data: input.userMeta,
      created_at: now,
      updated_at: now,
    };
    if (shape.users.has('aud')) row.aud = 'authenticated';
    if (shape.users.has('role')) row.role = 'authenticated';
    if (shape.users.has('instance_id')) row.instance_id = '00000000-0000-0000-0000-000000000000';
    for (const c of GOTRUE_EMPTY_STRING_COLS) if (shape.users.has(c)) row[c] = '';
    const cols = Object.keys(row).filter((c) => shape.users.has(c));
    const values = cols.map((c) => row[c]);
    await tx.unsafe(
      `insert into auth.users (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols
        .map((c, i) => (c.startsWith('raw_') ? `$${i + 1}::text::jsonb` : `$${i + 1}`))
        .join(', ')})`,
      values.map((v) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v)) as never[],
    );

    if (shape.identities) {
      const identityData = { sub: input.id, email: input.email.toLowerCase(), email_verified: true, phone_verified: false };
      const ident: Record<string, unknown> = {
        user_id: input.id,
        identity_data: JSON.stringify(identityData),
        provider: 'email',
        last_sign_in_at: now,
        created_at: now,
        updated_at: now,
      };
      if (shape.identities.has('provider_id')) ident.provider_id = input.id;
      else ident.id = input.id; // older GoTrue: id is the provider id (text)
      const icols = Object.keys(ident).filter((c) => shape.identities!.has(c));
      await tx.unsafe(
        `insert into auth.identities (${icols.map((c) => `"${c}"`).join(', ')}) values (${icols
          .map((c, i) => (c === 'identity_data' ? `$${i + 1}::text::jsonb` : `$${i + 1}`))
          .join(', ')})`,
        icols.map((c) => ident[c]) as never[],
      );
    }
    return (await this.findById(input.id, tx))!;
  }

  async setPassword(userId: string, passwordHash: string, q: Queryable = this.db): Promise<void> {
    await q`update auth.users set encrypted_password = ${passwordHash}, updated_at = now() where id = ${userId}`;
  }

  async mergeUserMeta(userId: string, patch: Record<string, unknown>, q: Queryable = this.db): Promise<void> {
    await q`
      update auth.users
      set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || ${q.json(patch as never)}::jsonb,
          updated_at = now()
      where id = ${userId}`;
  }

  async touchSignIn(userId: string): Promise<void> {
    await this.db`update auth.users set last_sign_in_at = now() where id = ${userId}`;
  }

  /** Mirrors a session family into auth.sessions so Supabase's own getUser() accepts our tokens (shared mode). */
  async mirrorSession(q: Queryable, sessionId: string, userId: string, meta: { userAgent?: string; ip?: string }): Promise<void> {
    if (this.mode !== 'shared') return;
    const shape = await this.describe();
    if (!shape.sessions) return;
    const now = new Date();
    const row: Record<string, unknown> = { id: sessionId, user_id: userId, created_at: now, updated_at: now };
    if (shape.sessions.has('aal')) row.aal = 'aal1';
    if (shape.sessions.has('user_agent')) row.user_agent = meta.userAgent ?? null;
    if (shape.sessions.has('ip')) row.ip = meta.ip ?? null;
    const cols = Object.keys(row).filter((c) => shape.sessions!.has(c));
    await q.unsafe(
      `insert into auth.sessions (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols
        .map((c, i) => (c === 'aal' ? `$${i + 1}::text::auth.aal_level` : `$${i + 1}`))
        .join(', ')}) on conflict (id) do nothing`,
      cols.map((c) => row[c]) as never[],
    ).catch(async () => {
      // auth.aal_level may not exist in very old GoTrue versions; retry without the cast.
      await q.unsafe(
        `insert into auth.sessions (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) on conflict (id) do nothing`,
        cols.map((c) => row[c]) as never[],
      );
    });
  }

  async dropSessions(q: Queryable, sessionIds: string[]): Promise<void> {
    if (this.mode !== 'shared' || sessionIds.length === 0) return;
    const shape = await this.describe();
    if (!shape.sessions) return;
    await q`delete from auth.sessions where id = any(${sessionIds}::uuid[])`;
  }

  /**
   * Accepts a refresh token issued by Supabase GoTrue exactly once (shared mode), revoking it, so signed-in users move
   * to this server's sessions without seeing a login screen.
   */
  async consumeSupabaseRefreshToken(q: Queryable, token: string): Promise<string | null> {
    if (this.mode !== 'shared') return null;
    const shape = await this.describe();
    if (!shape.refreshTokens || token.length > 200) return null;
    const rows = await q<{ user_id: string }[]>`
      update auth.refresh_tokens set revoked = true, updated_at = now()
      where token = ${token} and revoked = false
      returning user_id`;
    return rows[0]?.user_id ?? null;
  }
}

export function publicUser(u: AuthUser) {
  return {
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email ?? '',
    phone: u.phone ?? '',
    email_confirmed_at: u.email_confirmed_at,
    confirmed_at: u.email_confirmed_at,
    last_sign_in_at: u.last_sign_in_at,
    app_metadata: u.raw_app_meta_data ?? { provider: 'email', providers: ['email'] },
    user_metadata: u.raw_user_meta_data ?? {},
    identities: [],
    created_at: u.created_at,
    updated_at: u.updated_at,
    is_anonymous: false,
  };
}
