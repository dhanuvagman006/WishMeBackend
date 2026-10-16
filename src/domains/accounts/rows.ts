/**
 * Small helpers for domain code that writes public tables whose exact columns are only known from the schema cache
 * (the Supabase schema is owned by Supabase until cutover). Only columns that exist are written; every value is a
 * parameter cast through text to the column's real type (CONTRIBUTING.md rule 7).
 *
 * Also: `represent`, which answers a custom compat insert with the server's rows exactly as the generic engine would
 * (the client's `select`, the table's read grants, single-object responses).
 */
import { dbClaims } from '../../auth/context.js';
import { castType, compileRead, paramValue } from '../../compat/postgrest/compiler.js';
import { parseRead, pgrstError } from '../../compat/postgrest/parser.js';
import type { CompatResult, CustomArgs } from '../../compat/postgrest/policy.js';
import type { SchemaCache } from '../../compat/postgrest/schema-cache.js';
import { run, runAs, type Queryable } from '../../lib/db.js';
import { ident, join, Sql, sql } from '../../lib/sql.js';

/** Inserts one row into public.<table> (unknown columns dropped) and returns the stored row as JSON. */
export async function insertRow(q: Queryable, schema: SchemaCache, table: string, row: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const info = schema.table(table);
  if (!info) return null;
  const cols = Object.keys(row).filter((k) => info.columns.has(k) && row[k] !== undefined);
  if (cols.length === 0) return null;
  const values = cols.map((k) => {
    const v = row[k];
    if (v instanceof Sql) return v;
    const c = info.columns.get(k)!;
    return sql`${paramValue(c, v)}::text::${castType(c)}`;
  });
  const rows = await run<{ j: string }>(
    q,
    sql`insert into ${ident('public', table)} as t (${join(cols.map((c) => ident(c)))}) values (${join(values)}) returning to_jsonb(t)::text as j`,
  );
  return rows[0] ? (JSON.parse(rows[0].j) as Record<string, unknown>) : null;
}

/**
 * Updates public.<table> rows matching `where` (column = value pairs). Patch values may be Sql expressions (e.g. a
 * counter increment). Returns the updated rows.
 */
export async function updateRows(
  q: Queryable,
  schema: SchemaCache,
  table: string,
  where: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const info = schema.table(table);
  if (!info) return [];
  const cols = Object.keys(patch).filter((k) => info.columns.has(k) && patch[k] !== undefined);
  if (cols.length === 0) return [];
  const whereCols = Object.keys(where);
  if (whereCols.length === 0 || whereCols.some((k) => !info.columns.has(k))) throw new Error(`updateRows: bad filter for ${table}`);
  const sets = cols.map((k) => {
    const v = patch[k];
    const c = info.columns.get(k)!;
    return sql`${ident(k)} = ${v instanceof Sql ? v : sql`${paramValue(c, v)}::text::${castType(c)}`}`;
  });
  const conds = whereCols.map((k) => {
    const c = info.columns.get(k)!;
    return sql`t.${ident(k)} = ${paramValue(c, where[k])}::text::${castType(c)}`;
  });
  const rows = await run<{ j: string }>(
    q,
    sql`update ${ident('public', table)} as t set ${join(sets)} where ${join(conds, ' and ')} returning to_jsonb(t)::text as j`,
  );
  return rows.map((r) => JSON.parse(r.j) as Record<string, unknown>);
}

/** Does public.<table> have this column? (Optional columns differ between the app's code paths.) */
export function hasColumn(schema: SchemaCache, table: string, column: string): boolean {
  return schema.table(table)?.columns.has(column) ?? false;
}

/**
 * The 201 answer to a custom insert: empty unless the client asked for `return=representation`, in which case the
 * given rows are read back through the table's own read policy with the client's `select`.
 */
/** Runs a read through the table's policy exactly as the generic engine would; returns the json_agg body and row count. */
export async function readViaPolicy(a: CustomArgs, table: string, params: URLSearchParams): Promise<{ body: string; n: number }> {
  const compiled = compileRead({ schema: a.deps.schema, policies: a.deps.policies, auth: a.auth, identity: a.identity }, table, parseRead(params), false);
  const role = !a.deps.env.DB_RLS_PASSTHROUGH || a.auth.kind === 'service' ? null : a.auth.kind === 'anon' ? 'anon' : 'authenticated';
  const res = await runAs(a.deps.db, { role, claims: dbClaims(a.auth), statementTimeoutMs: a.deps.env.DB_STATEMENT_TIMEOUT_MS }, (tx) =>
    run<{ body: string; n: number }>(tx, compiled.query),
  );
  return { body: res[0]?.body ?? '[]', n: res[0]?.n ?? 0 };
}

export async function represent(a: CustomArgs, table: string, ids: readonly string[], status = 201): Promise<CompatResult> {
  if (!a.prefer.returnRepresentation) return { status };
  let body = '[]';
  let n = 0;
  if (ids.length > 0) {
    const params = new URLSearchParams();
    params.set('select', a.params.get('select') ?? '*');
    params.set('id', `in.(${ids.join(',')})`);
    ({ body, n } = await readViaPolicy(a, table, params));
  }
  if (a.single) {
    if (n !== 1) throw pgrstError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${n} rows`);
    return { status, body: JSON.stringify((JSON.parse(body) as unknown[])[0]) };
  }
  return { status, body };
}

/** Removes control characters and caps length (descriptions and names that end up in history rows and emails). */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}
