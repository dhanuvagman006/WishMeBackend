/**
 * Helpers the celebrities domain's custom PostgREST handlers share: running SQL as the caller (RLS passthrough),
 * answering with the engine's own representation of rows just written, schema-aware row writes, the uuid-list
 * predicate used by ownership rules, and checks for storage URLs the app stores in rows.
 */
import { dbClaims, type AuthContext, type Identity } from '../../auth/context.js';
import type { Deps } from '../../deps.js';
import { compileRead, castType, paramValue, type CompileEnv } from '../../compat/postgrest/compiler.js';
import { parseRead, parseSelect, pgrstError } from '../../compat/postgrest/parser.js';
import type { CompatResult, CustomArgs, PolicyCtx } from '../../compat/postgrest/policy.js';
import type { Filter } from '../../compat/postgrest/ast.js';
import { run, runAs, type Db, type Tx } from '../../lib/db.js';
import { AppError, forbidden, unauthorized } from '../../lib/errors.js';
import { ident, join, sql, type Sql } from '../../lib/sql.js';

const SINGLE_406 = () => pgrstError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');

/** `{a,b}` literal for a uuid[] parameter, cast through text (CONTRIBUTING rule 7). Ids come from the database. */
export function uuidArray(ids: readonly string[]): Sql {
  return sql`${`{${ids.join(',')}}`}::text::uuid[]`;
}

/** `column = any(<caller's celebrity ids>)`, or 'none' when the caller owns no celebrity. */
export function ownCelebrity(c: PolicyCtx, column = 'celebrity_id'): Sql | 'none' {
  return c.identity.celebrityIds.length ? sql`${c.col(column)} = any(${uuidArray(c.identity.celebrityIds)})` : 'none';
}

/** `column = <caller's profile id>`, or 'none' when the caller has no profile (anon, or sign-up still running). */
export function ownProfile(c: PolicyCtx, column = 'user_id'): Sql | 'none' {
  return c.identity.profileId ? sql`${c.col(column)} = ${c.identity.profileId}::uuid` : 'none';
}

/** The caller must be signed in with a profile; returns the profile id. */
export function requireProfile(auth: AuthContext, identity: Identity): string {
  if (auth.kind === 'anon' || !auth.userId) throw unauthorized('Sign in required');
  if (!identity.profileId) throw forbidden('A profile is required', '42501');
  return identity.profileId;
}

export function compileEnv(a: Pick<CustomArgs, 'deps' | 'auth' | 'identity'>): CompileEnv {
  return { schema: a.deps.schema, policies: a.deps.policies, auth: a.auth, identity: a.identity };
}

/** Same role selection as the generic engine: Supabase RLS stays a second wall in shared mode. */
function roleFor(deps: Deps, auth: AuthContext): 'anon' | 'authenticated' | null {
  if (!deps.env.DB_RLS_PASSTHROUGH || auth.kind === 'service') return null;
  return auth.kind === 'anon' ? 'anon' : 'authenticated';
}

/** Runs `fn` in a transaction scoped like a PostgREST request (role, claims, statement timeout). */
export function asCaller<T>(a: Pick<CustomArgs, 'deps' | 'auth'>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runAs(a.deps.db, { role: roleFor(a.deps, a.auth), claims: dbClaims(a.auth), statementTimeoutMs: a.deps.env.DB_STATEMENT_TIMEOUT_MS }, fn);
}

/**
 * The PostgREST answer for rows a custom handler just wrote: 201/200 with the rows as the table's read policy shows
 * them (honouring `select=` and single-object requests), or an empty body without `return=representation`.
 */
export async function represent(
  a: CustomArgs,
  q: Db | Tx,
  ids: readonly string[],
  status: 200 | 201,
): Promise<CompatResult> {
  if (!a.prefer.returnRepresentation) return { status: status === 201 ? 201 : 204 };
  const select = parseSelect(a.params.get('select') ?? undefined);
  const where: Filter[] = [{ kind: 'cond', column: 'id', op: 'in', negate: false, value: [...ids] }];
  const compiled = compileRead(compileEnv(a), a.table.name, { select, where, order: [] }, false);
  const rows = await run<{ body: string; n: number }>(q, compiled.query);
  const body = rows[0]?.body ?? '[]';
  const n = rows[0]?.n ?? 0;
  if (!a.single) return { status, body };
  if (n !== 1) throw SINGLE_406();
  return { status, body: JSON.stringify((JSON.parse(body) as unknown[])[0]) };
}

/**
 * Executes a GET the way the generic engine does (policy, filters, Content-Range, anon cache) for custom read handlers
 * that had to adjust the query string first.
 */
export async function readAs(a: CustomArgs, params: URLSearchParams, anonCacheSec: number | null): Promise<CompatResult> {
  const read = parseRead(params);
  const cacheKey = a.auth.kind === 'anon' && anonCacheSec && !a.prefer.count ? `pgrst:${a.table.name}:${params.toString()}` : null;
  let res: { body: string; n: number; total: number | null } | null = null;
  let cached = false;
  if (cacheKey) {
    const hit = await a.deps.kv.get(cacheKey);
    if (hit) {
      res = { ...(JSON.parse(hit) as { body: string; n: number }), total: null };
      cached = true;
    }
  }
  if (!res) {
    const compiled = compileRead(compileEnv(a), a.table.name, read, a.prefer.count !== null);
    res = await asCaller(a, async (tx) => {
      const rows = await run<{ body: string; n: number }>(tx, compiled.query);
      const total = compiled.count ? Number((await run<{ total: string }>(tx, compiled.count))[0]?.total ?? 0) : null;
      return { body: rows[0]?.body ?? '[]', n: rows[0]?.n ?? 0, total };
    });
    if (cacheKey) await a.deps.kv.set(cacheKey, JSON.stringify({ body: res.body, n: res.n }), anonCacheSec!);
  }
  const offset = read.offset ?? 0;
  const t = res.total === null ? '*' : String(res.total);
  const headers: Record<string, string> = { 'content-range': res.n === 0 ? `*/${t}` : `${offset}-${offset + res.n - 1}/${t}` };
  if (cached) headers['x-cache'] = 'hit';
  if (!a.single) return { status: 200, body: res.body, headers };
  if (res.n !== 1) throw SINGLE_406();
  return { status: 200, body: JSON.stringify((JSON.parse(res.body) as unknown[])[0]), headers };
}

/**
 * Inserts one row into a public table, writing only the columns that exist in the live schema (the real schema is
 * only known by introspection). Values are cast through text to each column's type. Returns the new id.
 */
export async function insertRow(deps: Deps, q: Db | Tx, table: string, row: Record<string, unknown>): Promise<string> {
  const info = deps.schema.table(table);
  if (!info) throw new AppError(503, 'schema_unavailable', `Table ${table} is not available`);
  const cols = Object.keys(row).filter((c) => info.columns.has(c) && row[c] !== undefined);
  const values = cols.map((c) => {
    const ci = info.columns.get(c)!;
    return sql`${paramValue(ci, row[c])}::text::${castType(ci)}`;
  });
  const res = await run<{ id: string }>(
    q,
    sql`insert into ${ident('public', table)} (${join(cols.map((c) => ident(c)))}) values (${join(values)}) returning id::text as id`,
  );
  return res[0]!.id;
}

/** Updates columns of one row by id, skipping columns the live schema does not have. */
export async function updateRow(deps: Deps, q: Db | Tx, table: string, id: string, patch: Record<string, unknown>): Promise<void> {
  const info = deps.schema.table(table);
  if (!info) throw new AppError(503, 'schema_unavailable', `Table ${table} is not available`);
  const cols = Object.keys(patch).filter((c) => info.columns.has(c) && patch[c] !== undefined);
  if (cols.length === 0) return;
  const sets = cols.map((c) => {
    const ci = info.columns.get(c)!;
    return sql`${ident(c)} = ${paramValue(ci, patch[c])}::text::${castType(ci)}`;
  });
  await run(q, sql`update ${ident('public', table)} set ${join(sets)} where id = ${id}::uuid`);
}

export function hasColumn(deps: Deps, table: string, column: string): boolean {
  return !!deps.schema.table(table)?.columns.has(column);
}

/** Parses a JSON object body (custom handlers receive the already-decoded body). */
export function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw pgrstError(400, 'PGRST102', 'Body must be a JSON object');
  return body as Record<string, unknown>;
}

// ── storage URLs ───────────────────────────────────────────────────────────────────────────────────────────

/** Folder name the app derives from a celebrity's display name for avatar and promo uploads (ContentTab.tsx). */
export function safeFolderName(name: string): string {
  return name.replace(/\s+/g, '_').toLowerCase();
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._\- ]{0,200}$/;

/**
 * Accepts only public object URLs of this server's storage (the app builds
 * `${SUPABASE_URL}/storage/v1/object/public/<bucket>/<path>`), in `bucket`, whose first path segment is one of
 * `folders`. During the transition the app's SUPABASE_URL may still be the Supabase project, so both origins count.
 * Returns the normalised URL or throws 400.
 */
export function checkStorageUrl(deps: Deps, value: unknown, bucket: string, folders: readonly string[], what: string): string {
  if (typeof value !== 'string' || value.length > 1000) throw new AppError(400, 'invalid_url', `Invalid ${what}`);
  const origins = [deps.env.PUBLIC_URL, deps.env.SUPABASE_URL].filter((o): o is string => !!o).map((o) => o.replace(/\/+$/, ''));
  const origin = origins.find((o) => value.startsWith(`${o}/storage/v1/object/public/${bucket}/`));
  if (!origin) throw new AppError(400, 'invalid_url', `${what} must be a file uploaded to WishMe storage`);
  const path = value.slice(`${origin}/storage/v1/object/public/${bucket}/`.length).split('?')[0]!;
  let segments: string[];
  try {
    segments = decodeURIComponent(path).split('/');
  } catch {
    throw new AppError(400, 'invalid_url', `Invalid ${what}`);
  }
  if (segments.length < 2 || segments.some((s) => !SAFE_SEGMENT.test(s) || s.includes('..'))) {
    throw new AppError(400, 'invalid_url', `Invalid ${what}`);
  }
  if (!folders.includes(segments[0]!)) throw forbidden(`${what} must be in your own storage folder`, '42501');
  return value;
}
