/**
 * Postgres access. One pooled client per process; transactions via `withTx`. The compat engine runs its statements
 * through `runAs`, which sets the database role and JWT claims for the transaction (Supabase RLS passthrough).
 */
import postgres from 'postgres';
import type { Env } from '../config/env.js';
import type { Logger } from './logger.js';
import type { Sql } from './sql.js';

export type Db = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Either the pool or an open transaction: anything that can run a query. */
export type Queryable = Db | Tx;

export function createDb(env: Env, log: Logger, opts: { max?: number; direct?: boolean } = {}): Db {
  const url = opts.direct ? (env.DATABASE_URL_DIRECT ?? env.DATABASE_URL) : env.DATABASE_URL;
  return postgres(url, {
    max: opts.max ?? env.DB_POOL_MAX,
    prepare: opts.direct ? true : env.DB_PREPARE,
    ssl: env.DB_SSL === 'disable' ? false : env.DB_SSL === 'require' ? 'require' : 'verify-full',
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    connect_timeout: 10,
    connection: { application_name: 'wishme-backend', statement_timeout: env.DB_STATEMENT_TIMEOUT_MS },
    // Keep int8 and numeric exact: domain code converts explicitly. Compat responses are JSON built by Postgres.
    onnotice: (n) => log.debug({ notice: n.message }, 'postgres notice'),
  });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await db.begin(fn)) as T;
}

/** Runs a fragment built with lib/sql.ts. */
export async function run<T extends postgres.Row = postgres.Row>(q: Queryable, fragment: Sql): Promise<T[]> {
  const { text, values } = fragment.toQuery();
  return (await q.unsafe(text, values as postgres.ParameterOrJSON<never>[])) as unknown as T[];
}

export interface DbRoleContext {
  /** 'anon' | 'authenticated' | null (null = stay as the connection role, i.e. no RLS passthrough). */
  role: 'anon' | 'authenticated' | null;
  /** JWT claims as Supabase RLS expects them in request.jwt.claims. */
  claims: Record<string, unknown>;
  statementTimeoutMs: number;
}

/**
 * Opens a transaction scoped like a PostgREST request: statement timeout, then (when enabled) the database role and
 * JWT claims, so `auth.uid()` and existing RLS policies see the caller.
 */
export async function runAs<T>(db: Db, ctx: DbRoleContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(db, async (tx) => {
    await tx.unsafe(
      `select set_config('statement_timeout', $1, true), set_config('request.jwt.claims', $2, true), set_config('request.jwt.claim.sub', $3, true), set_config('request.jwt.claim.role', $4, true)`,
      [
        String(ctx.statementTimeoutMs),
        JSON.stringify(ctx.claims),
        String(ctx.claims.sub ?? ''),
        String(ctx.claims.role ?? ''),
      ],
    );
    // Role names are constants from a closed set, never user input.
    if (ctx.role === 'authenticated') await tx.unsafe('set local role authenticated');
    else if (ctx.role === 'anon') await tx.unsafe('set local role anon');
    return fn(tx);
  });
}

export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db`select 1`;
    return true;
  } catch {
    return false;
  }
}
