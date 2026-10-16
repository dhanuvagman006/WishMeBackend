/**
 * Compiles a parsed PostgREST request plus the table's policy into one parameterised SQL statement. Postgres builds the
 * JSON response itself (json_agg / row_to_json), exactly like PostgREST, so numbers, timestamps, JSON columns and nested
 * embeds serialise the way the app already expects.
 *
 * Every value is a parameter cast to the column's real type; every identifier comes from the schema cache.
 */
import { AppError, forbidden } from '../../lib/errors.js';
import { and, ident, join, or, raw, sql, type Sql } from '../../lib/sql.js';
import type { Condition, EmbedItem, Filter, OrderItem, ReadRequest, SelectItem } from './ast.js';
import { pgrstError } from './parser.js';
import type { PolicyCtx, ReadGrant, RowRule, TablePolicy, WriteRule } from './policy.js';
import type { PolicyRegistry } from './policy.js';
import type { ColumnInfo, ForeignKey, SchemaCache, TableInfo } from './schema-cache.js';
import type { AuthContext, Identity } from '../../auth/context.js';

const SCHEMA = 'public';

export interface CompileEnv {
  schema: SchemaCache;
  policies: PolicyRegistry;
  auth: AuthContext;
  identity: Identity;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

export function tableOrThrow(env: CompileEnv, name: string): { info: TableInfo; policy: TablePolicy } {
  const policy = env.policies.table(name);
  const info = env.schema.table(name);
  if (!policy || !info) {
    throw new AppError(404, '42P01', `relation "${SCHEMA}.${name}" does not exist`, null,
      `Perhaps you meant a table this API exposes. Tables without a policy are not reachable.`);
  }
  return { info, policy };
}

/** SQL type for casting a parameter to a column's type. Names come from the catalog, never from the client. */
export function castType(c: ColumnInfo): Sql {
  if (c.type === 'ARRAY') {
    const base = c.udt.startsWith('_') ? c.udt.slice(1) : c.udt;
    return sql`${ident(base)}[]`;
  }
  if (/^[a-z][a-z0-9 ]*$/.test(c.type)) return raw(c.type);
  return ident(c.udt);
}

const isJsonType = (c: ColumnInfo) => c.type === 'json' || c.type === 'jsonb';

/** Serialises a JS value for a text parameter that is then cast to the column type. */
export function paramValue(c: ColumnInfo, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (isJsonType(c)) return JSON.stringify(v);
  if (c.type === 'ARRAY') {
    if (!Array.isArray(v)) throw pgrstError(400, '22P02', `malformed array literal for column "${c.name}"`);
    return toPgArray(v);
  }
  if (typeof v === 'object') {
    throw pgrstError(400, '22P02', `invalid input for column "${c.name}": expected a scalar value`);
  }
  return String(v);
}

function toPgArray(values: unknown[]): string {
  const items = values.map((x) => {
    if (x === null || x === undefined) return 'NULL';
    const s = typeof x === 'object' ? JSON.stringify(x) : String(x);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${items.join(',')}}`;
}

function typed(c: ColumnInfo, v: unknown): Sql {
  // Through text first: postgres.js must not re-serialise a value it believes is json/jsonb.
  return sql`${paramValue(c, v)}::text::${castType(c)}`;
}

function column(info: TableInfo, name: string, what = 'column'): ColumnInfo {
  const c = info.columns.get(name);
  if (!c) {
    throw new AppError(400, '42703', `column ${info.name}.${name} does not exist`, null, `Unknown ${what} "${name}"`);
  }
  return c;
}

function ruleSql(rule: RowRule | undefined, pc: PolicyCtx): Sql {
  if (!rule) return sql`false`;
  const r = rule(pc);
  if (r === 'all') return sql`true`;
  if (r === 'none') return sql`false`;
  return r;
}

function policyCtx(env: CompileEnv, alias: string): PolicyCtx {
  return { auth: env.auth, identity: env.identity, col: (name) => ident(alias, name) };
}

// ── read masking ─────────────────────────────────────────────────────────────────────────────────────────────

interface Visibility {
  /** Row predicate: any grant covers the row. */
  rows: Sql;
  /** Masked expression for a column (null where no covering grant reveals it). */
  expr(name: string): Sql;
  /** Columns that some grant can reveal (for `*`). */
  readable: string[];
}

function visibility(env: CompileEnv, info: TableInfo, policy: TablePolicy, alias: string): Visibility {
  const grants: readonly ReadGrant[] = policy.read ?? [];
  if (grants.length === 0) throw forbidden(`permission denied for table ${info.name}`, '42501');
  const hidden = new Set(policy.hiddenColumns ?? []);
  const pc = policyCtx(env, alias);
  const compiled = grants.map((g) => ({
    rows: ruleSql(g.rows, pc),
    cols: g.columns === '*' ? null : new Set(g.columns),
  }));
  const reveals = (grantCols: Set<string> | null, name: string) => !hidden.has(name) && (grantCols === null || grantCols.has(name));
  const readable = [...info.columns.keys()].filter((n) => compiled.some((g) => reveals(g.cols, n)));
  const rows = or(compiled.map((g) => g.rows));
  const computed = policy.computed ?? {};
  const masked = (name: string): Sql => {
    column(info, name);
    const covering = compiled.filter((g) => reveals(g.cols, name));
    if (covering.length === 0) return sql`null`;
    // Revealed by every grant: no mask needed.
    if (covering.length === compiled.length) return ident(alias, name);
    return sql`case when ${or(covering.map((g) => g.rows))} then ${ident(alias, name)} end`;
  };
  return {
    rows,
    readable: [...readable, ...Object.keys(computed).filter((k) => !info.columns.has(k))],
    expr(name) {
      const virtual = computed[name];
      return virtual && !info.columns.has(name) ? virtual(masked, pc) : masked(name);
    },
  };
}

// ── filters and order ────────────────────────────────────────────────────────────────────────────────────────

const OP_SQL: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function conditionSql(info: TableInfo, vis: Visibility | null, alias: string, c: Condition): Sql {
  const col = column(info, c.column, 'filter column');
  const expr = vis ? vis.expr(c.column) : ident(alias, c.column);
  let out: Sql;
  switch (c.op) {
    case 'is': {
      const v = c.value as string;
      out = sql`${expr} is ${raw(v === 'null' ? 'null' : v === 'true' ? 'true' : v === 'false' ? 'false' : 'unknown')}`;
      break;
    }
    case 'in': {
      const list = c.value as string[];
      out = sql`${expr} = any(${toPgArray(list)}::text::${castType(col)}[])`;
      if (col.type === 'ARRAY') throw pgrstError(400, 'PGRST100', 'in. is not supported on array columns');
      break;
    }
    case 'like':
    case 'ilike': {
      const pattern = String(c.value).replace(/\*/g, '%');
      out = sql`${expr}::text ${raw(c.op)} ${pattern}`;
      break;
    }
    default: {
      out = sql`${expr} ${raw(OP_SQL[c.op]!)} ${typed(col, c.value)}`;
    }
  }
  return c.negate ? sql`not (${out})` : out;
}

export function filtersSql(info: TableInfo, vis: Visibility | null, alias: string, filters: readonly Filter[]): Sql {
  const one = (f: Filter): Sql => {
    if (f.kind === 'cond') return conditionSql(info, vis, alias, f);
    const inner = f.op === 'and' ? and(f.items.map(one)) : or(f.items.map(one));
    return f.negate ? sql`not ${inner}` : inner;
  };
  return and(filters.map(one));
}

function orderSql(info: TableInfo, vis: Visibility, order: readonly OrderItem[]): Sql | null {
  if (order.length === 0) return null;
  return join(
    order.map((o) => {
      column(info, o.column, 'order column');
      const nulls = o.nulls ? raw(o.nulls === 'first' ? ' nulls first' : ' nulls last') : raw('');
      return sql`${vis.expr(o.column)} ${raw(o.dir)}${nulls}`;
    }),
  );
}

// ── embeds ───────────────────────────────────────────────────────────────────────────────────────────────────

interface Relationship {
  fk: ForeignKey;
  /** many-to-one: the parent holds the FK; one-to-many: the child holds it. */
  cardinality: 'm2o' | 'o2m';
  child: string;
}

function resolveRelationship(env: CompileEnv, parent: TableInfo, embed: EmbedItem): Relationship {
  const fks = env.schema.foreignKeys();
  // `alias:fk_column(...)` — the target names a column of the parent that is a foreign key.
  if (parent.columns.has(embed.target) && !env.schema.table(embed.target)) {
    const fk = fks.find((f) => f.table === parent.name && f.columns.length === 1 && f.columns[0] === embed.target);
    if (!fk) throw pgrstError(400, 'PGRST200', `Could not find a relationship between '${parent.name}' and '${embed.target}' in the schema cache`);
    return { fk, cardinality: 'm2o', child: fk.refTable };
  }
  const target = embed.target;
  let candidates: Relationship[] = [
    ...fks.filter((f) => f.table === parent.name && f.refTable === target).map((fk) => ({ fk, cardinality: 'm2o' as const, child: target })),
    ...fks.filter((f) => f.table === target && f.refTable === parent.name).map((fk) => ({ fk, cardinality: 'o2m' as const, child: target })),
  ];
  if (embed.hint) {
    const h = embed.hint;
    candidates = candidates.filter((r) => r.fk.name === h || (r.fk.columns.length === 1 && r.fk.columns[0] === h));
  }
  if (candidates.length === 0) {
    throw pgrstError(400, 'PGRST200', `Could not find a relationship between '${parent.name}' and '${target}' in the schema cache`);
  }
  if (candidates.length > 1) {
    throw pgrstError(300, 'PGRST201', `Could not embed because more than one relationship was found for '${parent.name}' and '${target}'`,
      candidates.map((c) => c.fk.name).join(', '), `Try changing '${target}' to one of: ${candidates.map((c) => `${target}!${c.fk.name}`).join(', ')}`);
  }
  return candidates[0]!;
}

function joinCondition(rel: Relationship, parentAlias: string, childAlias: string): Sql {
  const pairs = rel.fk.columns.map((c, i) => {
    const r = rel.fk.refColumns[i]!;
    // FK columns live on fk.table. m2o: parent holds them; o2m: child holds them.
    return rel.cardinality === 'm2o'
      ? sql`${ident(childAlias, r)} = ${ident(parentAlias, c)}`
      : sql`${ident(childAlias, c)} = ${ident(parentAlias, r)}`;
  });
  return and(pairs);
}

interface Counter {
  n: number;
}

function embedSql(env: CompileEnv, parent: TableInfo, parentAlias: string, embed: EmbedItem, counter: Counter): { select: Sql; innerExists: Sql | null } {
  const rel = resolveRelationship(env, parent, embed);
  const { info, policy } = tableOrThrow(env, rel.child);
  const alias = `t${++counter.n}`;
  const vis = visibility(env, info, policy, alias);
  const where = and([joinCondition(rel, parentAlias, alias), vis.rows]);
  const key = embed.alias ?? embed.target;
  const fromSql = sql`from ${ident(SCHEMA, info.name)} as ${ident(alias)}`;

  const onlyCount = embed.select.length === 1 && embed.select[0]!.kind === 'count';
  let select: Sql;
  if (onlyCount) {
    select = sql`(select json_build_array(json_build_object('count', count(*))) ${fromSql} where ${where}) as ${ident(key)}`;
  } else {
    const cols = selectList(env, info, vis, alias, embed.select, counter);
    const inner = sql`select ${cols.list} ${fromSql} where ${and([where, cols.innerExists])}`;
    select =
      rel.cardinality === 'm2o'
        ? sql`(select row_to_json(_e) from (${inner} limit 1) _e) as ${ident(key)}`
        : sql`(select coalesce(json_agg(_e), '[]'::json) from (${inner}) _e) as ${ident(key)}`;
  }
  const innerExists = embed.inner ? sql`exists (select 1 ${fromSql} where ${where})` : null;
  return { select, innerExists };
}

function selectList(env: CompileEnv, info: TableInfo, vis: Visibility, alias: string, items: readonly SelectItem[], counter: Counter): { list: Sql; innerExists: Sql | null } {
  const parts: Sql[] = [];
  const inner: Sql[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (it.kind === 'star') {
      for (const name of vis.readable) {
        if (seen.has(name)) continue;
        seen.add(name);
        parts.push(sql`${vis.expr(name)} as ${ident(name)}`);
      }
    } else if (it.kind === 'column') {
      const key = it.alias ?? it.name;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(sql`${vis.expr(it.name)} as ${ident(key)}`);
    } else if (it.kind === 'count') {
      throw pgrstError(400, 'PGRST100', 'count is only supported inside an embedded resource');
    } else {
      const e = embedSql(env, info, alias, it, counter);
      parts.push(e.select);
      if (e.innerExists) inner.push(e.innerExists);
    }
  }
  if (parts.length === 0) throw pgrstError(400, 'PGRST100', 'Empty select');
  return { list: join(parts), innerExists: inner.length ? and(inner) : null };
}

// ── statements ───────────────────────────────────────────────────────────────────────────────────────────────

export interface Compiled {
  /** Returns one row: { body: text JSON array, n: int }. */
  query: Sql;
  /** Optional count query returning { total: bigint }. */
  count?: Sql;
}

export function compileRead(env: CompileEnv, tableName: string, req: ReadRequest, withCount: boolean): Compiled {
  const { info, policy } = tableOrThrow(env, tableName);
  const counter: Counter = { n: 0 };
  const alias = 't0';
  const vis = visibility(env, info, policy, alias);
  const cols = selectList(env, info, vis, alias, req.select, counter);
  const where = and([vis.rows, filtersSql(info, vis, alias, req.where), cols.innerExists]);
  const order = orderSql(info, vis, req.order);
  const from = sql`from ${ident(SCHEMA, info.name)} as ${ident(alias)}`;
  const inner = sql`select ${cols.list} ${from} where ${where}${order ? sql` order by ${order}` : raw('')}${
    req.limit !== undefined ? sql` limit ${req.limit}` : raw('')
  }${req.offset !== undefined ? sql` offset ${req.offset}` : raw('')}`;
  const query = sql`select coalesce(json_agg(_r), '[]'::json)::text as body, count(*)::int as n from (${inner}) _r`;
  const out: Compiled = { query };
  if (withCount) out.count = sql`select count(*) as total ${from} where ${where}`;
  return out;
}

function returning(env: CompileEnv, info: TableInfo, policy: TablePolicy, cteName: string, select: readonly SelectItem[]): Sql {
  const counter: Counter = { n: 100 };
  const alias = 't0';
  const vis = visibility(env, info, policy, alias);
  const cols = selectList(env, info, vis, alias, select, counter);
  // Rows just written by the caller are returned only where the read grants cover them.
  return sql`select coalesce(json_agg(_r), '[]'::json)::text as body, count(*)::int as n from (select ${cols.list} from ${ident(cteName)} as ${ident(alias)} where ${and([vis.rows, cols.innerExists])}) _r`;
}

/** Applies a write rule to client rows: allowed columns, forced values, checks. Mutates nothing the caller owns. */
export async function prepareRows(
  info: TableInfo,
  rule: WriteRule,
  rows: readonly unknown[],
  pc: PolicyCtx,
  deps: import('../../deps.js').Deps,
): Promise<Record<string, unknown>[]> {
  const allowed = new Set(rule.columns);
  const forced = rule.set ? rule.set(pc) : {};
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw pgrstError(400, 'PGRST102', 'Each row must be a JSON object');
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (k in forced) continue;
      if (!allowed.has(k)) {
        if (rule.dropUnknown) continue;
        throw new AppError(403, '42501', `permission denied to write column "${k}" of ${info.name}`, null,
          info.columns.has(k) ? 'This column is set by the server.' : `Unknown column "${k}".`);
      }
      column(info, k);
      row[k] = v;
    }
    for (const [k, v] of Object.entries(forced)) {
      column(info, k);
      row[k] = v;
    }
    if (rule.check) await rule.check(row, pc, deps);
    out.push(row);
  }
  return out;
}

export function compileInsert(
  env: CompileEnv,
  tableName: string,
  rows: readonly Record<string, unknown>[],
  opts: { onConflict: string[] | null; merge: boolean; ignore: boolean; select: readonly SelectItem[] | null },
): Compiled {
  const { info, policy } = tableOrThrow(env, tableName);
  if (rows.length === 0) throw pgrstError(400, 'PGRST102', 'Empty or invalid json');
  const colNames = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (colNames.length === 0) throw pgrstError(400, 'PGRST102', 'Nothing to insert');
  const cols = colNames.map((n) => column(info, n));
  const values = join(
    rows.map((r) => sql`(${join(cols.map((c) => (c.name in r ? typed(c, r[c.name]) : raw('default'))))})`),
  );
  let conflict: Sql = raw('');
  if (opts.onConflict) {
    const target = opts.onConflict;
    const ok = (policy.upsertOn ?? []).some((u) => u.length === target.length && u.every((c, i) => c === target[i]));
    if (!ok) throw new AppError(403, '42501', `upsert on (${target.join(',')}) is not allowed for ${info.name}`);
    if (opts.ignore) {
      conflict = sql` on conflict (${join(target.map((c) => ident(c)))}) do nothing`;
    } else if (opts.merge) {
      if (!policy.update) throw new AppError(403, '42501', `permission denied to update ${info.name}`);
      const updatable = new Set(policy.update.columns);
      // The existing row is referenced through the insert target's alias (see `as tu` below).
      const forcedOnUpdate = policy.update.set ? Object.keys(policy.update.set(policyCtx(env, 'tu'))) : [];
      const setCols = colNames.filter((c) => !target.includes(c) && (updatable.has(c) || forcedOnUpdate.includes(c)));
      const rowsRule = ruleSql(policy.update.rows, policyCtx(env, 'tu'));
      conflict = setCols.length
        ? sql` on conflict (${join(target.map((c) => ident(c)))}) do update set ${join(setCols.map((c) => sql`${ident(c)} = excluded.${ident(c)}`))} where ${rowsRule}`
        : sql` on conflict (${join(target.map((c) => ident(c)))}) do nothing`;
    } else {
      throw pgrstError(400, 'PGRST100', 'on_conflict needs Prefer: resolution=merge-duplicates or ignore-duplicates');
    }
  }
  const insert = sql`insert into ${ident(SCHEMA, info.name)} as tu (${join(cols.map((c) => ident(c.name)))}) values ${values}${conflict} returning tu.*`;
  if (!opts.select) return { query: sql`with ins as (${insert}) select '[]'::text as body, count(*)::int as n from ins` };
  return { query: sql`with ins as (${insert}) ${returning(env, info, policy, 'ins', opts.select)}` };
}

export function compileUpdate(
  env: CompileEnv,
  tableName: string,
  patch: Record<string, unknown>,
  filters: readonly Filter[],
  select: readonly SelectItem[] | null,
): Compiled {
  const { info, policy } = tableOrThrow(env, tableName);
  if (!policy.update) throw new AppError(403, '42501', `permission denied to update ${info.name}`);
  if (filters.length === 0) throw pgrstError(400, '21000', 'UPDATE requires a WHERE clause', null as never, 'Add a filter such as id=eq.<id>.');
  const keys = Object.keys(patch);
  if (keys.length === 0) throw pgrstError(400, 'PGRST102', 'Nothing to update');
  const alias = 't0';
  const pc = policyCtx(env, alias);
  const vis = policy.read?.length ? visibility(env, info, policy, alias) : null;
  const sets = join(keys.map((k) => sql`${ident(k)} = ${typed(column(info, k), patch[k])}`));
  const where = and([ruleSql(policy.update.rows, pc), filtersSql(info, vis, alias, filters)]);
  const update = sql`update ${ident(SCHEMA, info.name)} as ${ident(alias)} set ${sets} where ${where} returning ${ident(alias)}.*`;
  if (!select) return { query: sql`with upd as (${update}) select '[]'::text as body, count(*)::int as n from upd` };
  return { query: sql`with upd as (${update}) ${returning(env, info, policy, 'upd', select)}` };
}

export function compileDelete(env: CompileEnv, tableName: string, filters: readonly Filter[], select: readonly SelectItem[] | null): Compiled {
  const { info, policy } = tableOrThrow(env, tableName);
  if (!policy.delete) throw new AppError(403, '42501', `permission denied to delete from ${info.name}`);
  if (filters.length === 0) throw pgrstError(400, '21000', 'DELETE requires a WHERE clause', null as never, 'Add a filter such as id=eq.<id>.');
  const alias = 't0';
  const pc = policyCtx(env, alias);
  const vis = policy.read?.length ? visibility(env, info, policy, alias) : null;
  const where = and([ruleSql(policy.delete.rows, pc), filtersSql(info, vis, alias, filters)]);
  const del = sql`delete from ${ident(SCHEMA, info.name)} as ${ident(alias)} where ${where} returning ${ident(alias)}.*`;
  if (!select) return { query: sql`with del as (${del}) select '[]'::text as body, count(*)::int as n from del` };
  return { query: sql`with del as (${del}) ${returning(env, info, policy, 'del', select)}` };
}

/** Startup check: every column a policy names must exist, so typos fail at boot instead of at request time. */
export function validatePolicies(schema: SchemaCache, policies: PolicyRegistry): string[] {
  const problems: string[] = [];
  for (const p of policies.allTables()) {
    const info = schema.table(p.table);
    if (!info) {
      problems.push(`policy for missing table "${p.table}"`);
      continue;
    }
    const check = (cols: readonly string[] | '*' | undefined, where: string) => {
      if (!cols || cols === '*') return;
      for (const c of cols) if (!info.columns.has(c)) problems.push(`${p.table}: ${where} names unknown column "${c}"`);
    };
    check(p.hiddenColumns, 'hiddenColumns');
    for (const g of p.read ?? []) check(g.columns, `read grant "${g.name}"`);
    check(p.insert?.columns, 'insert.columns');
    check(p.update?.columns, 'update.columns');
    for (const u of p.upsertOn ?? []) check(u, 'upsertOn');
    check(p.realtime?.filterColumns, 'realtime.filterColumns');
    for (const k of Object.keys(p.computed ?? {})) {
      if (info.columns.has(k)) problems.push(`${p.table}: computed column "${k}" shadows a real column`);
    }
  }
  return problems;
}
