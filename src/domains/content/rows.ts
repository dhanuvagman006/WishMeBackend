/**
 * Server-side writes to the app's content tables. The real Supabase columns are only known by introspection (and two
 * screens sometimes read different names for the same value), so rows are written with the columns the live schema
 * actually has: unknown keys are dropped, every value is a parameter cast to the column's own type through text.
 * Rows come back serialised by Postgres (row_to_json), so numbers and timestamps have the shapes PostgREST gives.
 */
import { castType, paramValue } from '../../compat/postgrest/compiler.js';
import type { SchemaCache, TableInfo } from '../../compat/postgrest/schema-cache.js';
import { run, type Queryable } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { and, ident, join, sql, type Sql } from '../../lib/sql.js';

export type Row = Record<string, unknown>;

export function tableInfo(schema: SchemaCache, table: string): TableInfo {
  const info = schema.table(table);
  if (!info) throw new AppError(503, 'schema_unavailable', `Table ${table} is not available`);
  return info;
}

function typedValue(info: TableInfo, name: string, v: unknown): Sql {
  const c = info.columns.get(name)!;
  return sql`${paramValue(c, v)}::text::${castType(c)}`;
}

function present(info: TableInfo, row: Row): string[] {
  return Object.keys(row).filter((k) => info.columns.has(k) && row[k] !== undefined);
}

/** Inserts one row (only existing columns) and returns it as the API would serialise it. */
export async function insertRow(q: Queryable, schema: SchemaCache, table: string, row: Row): Promise<Row> {
  const info = tableInfo(schema, table);
  const cols = present(info, row);
  if (cols.length === 0) throw new AppError(500, 'nothing_to_insert', `No known columns for ${table}`);
  const rows = await run<{ j: string }>(
    q,
    sql`insert into ${ident('public', table)} as t (${join(cols.map((c) => ident(c)))})
        values (${join(cols.map((c) => typedValue(info, c, row[c])))}) returning row_to_json(t)::text as j`,
  );
  return JSON.parse(rows[0]!.j) as Row;
}

/**
 * Updates the row with this id (only existing columns), optionally guarded by an extra predicate on the row
 * (alias `t`). Returns the updated row, or null when nothing matched.
 */
export async function updateRow(q: Queryable, schema: SchemaCache, table: string, id: string, patch: Row, guard?: Sql): Promise<Row | null> {
  const info = tableInfo(schema, table);
  const cols = present(info, patch);
  if (cols.length === 0) return selectRow(q, schema, table, id);
  const rows = await run<{ j: string }>(
    q,
    sql`update ${ident('public', table)} as t set ${join(cols.map((c) => sql`${ident(c)} = ${typedValue(info, c, patch[c])}`))}
        where ${and([sql`t.id = ${id}::text::uuid`, guard ?? null])} returning row_to_json(t)::text as j`,
  );
  return rows[0] ? (JSON.parse(rows[0].j) as Row) : null;
}

export async function selectRow(q: Queryable, schema: SchemaCache, table: string, id: string, opts: { lock?: boolean } = {}): Promise<Row | null> {
  tableInfo(schema, table);
  const rows = await run<{ j: string }>(
    q,
    sql`select row_to_json(t)::text as j from ${ident('public', table)} as t where t.id = ${id}::text::uuid${opts.lock ? sql` for update` : sql``}`,
  );
  return rows[0] ? (JSON.parse(rows[0].j) as Row) : null;
}

/** True when the table exists and has this column (the real schema may differ from the fixtures). */
export function hasColumn(schema: SchemaCache, table: string, column: string): boolean {
  return schema.table(table)?.columns.has(column) ?? false;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
