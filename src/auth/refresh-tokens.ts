/**
 * Refresh tokens: opaque, 256-bit, stored as keyed hashes, rotated on every use. A family is one sign-in. Presenting a
 * token that was already rotated:
 *  - within REFRESH_REUSE_GRACE_SEC (a network retry): allowed, the family's current token is rotated again;
 *  - later: treated as theft, and the whole family is revoked.
 */
import type { Env } from '../config/env.js';
import type { Db, Tx } from '../lib/db.js';
import { pepperedHash, randomToken } from '../lib/crypto.js';

export const TOKEN_PREFIX = 'wm1_';

export interface IssuedRefresh {
  token: string;
  id: string;
  familyId: string;
}

export interface RotateResult {
  userId: string;
  familyId: string;
  issued: IssuedRefresh;
}

export type RotateFailure = 'not_found' | 'expired' | 'revoked' | 'reused';

export class RefreshTokens {
  constructor(
    private readonly db: Db,
    private readonly env: Env,
  ) {}

  private hash(token: string) {
    return pepperedHash(this.env.AUTH_PEPPER, `refresh:${token}`);
  }

  isOurs(token: string): boolean {
    return token.startsWith(TOKEN_PREFIX);
  }

  async issue(tx: Tx | Db, userId: string, familyId: string, meta: { userAgent?: string; ip?: string }): Promise<IssuedRefresh> {
    const token = `${TOKEN_PREFIX}${randomToken(32)}`;
    const rows = await tx<{ id: string }[]>`
      insert into wishme.refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
      values (${userId}, ${familyId}, ${this.hash(token)},
              now() + make_interval(days => ${this.env.REFRESH_TOKEN_TTL_DAYS}),
              ${meta.userAgent?.slice(0, 300) ?? null}, ${meta.ip ?? null})
      returning id`;
    return { token, id: rows[0]!.id, familyId };
  }

  /** Rotates a token inside the caller's transaction. Returns the failure kind instead of throwing. */
  async rotate(tx: Tx, token: string, meta: { userAgent?: string; ip?: string }): Promise<RotateResult | RotateFailure> {
    const rows = await tx<
      { id: string; user_id: string; family_id: string; expires_at: Date; revoked_at: Date | null; revoked_reason: string | null }[]
    >`
      select id, user_id, family_id, expires_at, revoked_at, revoked_reason
      from wishme.refresh_tokens where token_hash = ${this.hash(token)} for update`;
    const row = rows[0];
    if (!row) return 'not_found';
    if (row.expires_at.getTime() <= Date.now()) return 'expired';

    if (row.revoked_at) {
      const age = (Date.now() - row.revoked_at.getTime()) / 1000;
      if (row.revoked_reason === 'rotated' && age <= this.env.REFRESH_REUSE_GRACE_SEC) {
        // A retry of a refresh that already succeeded: rotate the family's live token instead.
        const live = await tx<{ id: string }[]>`
          select id from wishme.refresh_tokens
          where family_id = ${row.family_id} and revoked_at is null and expires_at > now()
          order by created_at desc limit 1 for update`;
        if (live[0]) {
          await tx`update wishme.refresh_tokens set revoked_at = now(), revoked_reason = 'rotated' where id = ${live[0].id}`;
        }
        const issued = await this.issue(tx, row.user_id, row.family_id, meta);
        return { userId: row.user_id, familyId: row.family_id, issued };
      }
      if (row.revoked_reason === 'rotated') {
        await this.revokeFamily(tx, row.family_id, 'reuse_detected');
        return 'reused';
      }
      return 'revoked';
    }

    const issued = await this.issue(tx, row.user_id, row.family_id, meta);
    await tx`
      update wishme.refresh_tokens set revoked_at = now(), revoked_reason = 'rotated', replaced_by = ${issued.id}
      where id = ${row.id}`;
    return { userId: row.user_id, familyId: row.family_id, issued };
  }

  async revokeFamily(q: Tx | Db, familyId: string, reason: string): Promise<void> {
    await q`
      update wishme.refresh_tokens set revoked_at = now(), revoked_reason = ${reason}
      where family_id = ${familyId} and revoked_at is null`;
  }

  /** Revokes every family of a user except `keepFamilyId`; returns the revoked family ids. */
  async revokeAllForUser(q: Tx | Db, userId: string, reason: string, keepFamilyId?: string): Promise<string[]> {
    const rows = await q<{ family_id: string }[]>`
      update wishme.refresh_tokens set revoked_at = now(), revoked_reason = ${reason}
      where user_id = ${userId} and revoked_at is null
        and (${keepFamilyId ?? null}::uuid is null or family_id <> ${keepFamilyId ?? null}::uuid)
      returning family_id`;
    return [...new Set(rows.map((r) => r.family_id))];
  }

  /** Housekeeping: drop tokens expired more than 7 days ago. */
  async purgeExpired(): Promise<number> {
    const rows = await this.db`delete from wishme.refresh_tokens where expires_at < now() - interval '7 days' returning 1`;
    return rows.length;
  }
}
