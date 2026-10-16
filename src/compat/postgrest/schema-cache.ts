/**
 * What the database actually contains, discovered by introspection (like PostgREST's schema cache). The compiler only
 * emits identifiers that exist here, and policies are checked against it at startup so a typo in a policy fails loudly
 * instead of silently allowing or denying.
 */
import type { Db } from '../../lib/db.js';
import type { Logger } from '../../lib/logger.js';

export interface ColumnInfo {
  name: string;
  /** Postgres type name as used in casts, e.g. "uuid", "text", "timestamptz", "numeric", "jsonb", "USER-DEFINED". */
  type: string;
  udt: string;
  nullable: boolean;
  hasDefault: boolean;
  generated: boolean;
}

export interface ForeignKey {
  name: string;
  /** Referencing table and columns. */
  table: string;
  columns: string[];
  /** Referenced table and columns. */
  refTable: string;
  refColumns: string[];
}

export interface TableInfo {
  name: string;
  isView: boolean;
  columns: Map<string, ColumnInfo>;
  primaryKey: string[];
  /** Unique column sets (for on_conflict validation), including the primary key. */
  uniques: string[][];
}

export class SchemaCache {
  private tables = new Map<string, TableInfo>();
  private fks: ForeignKey[] = [];
  private loadedAt = 0;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly schema = 'public',
  ) {}

  get isLoaded(): boolean {
    return this.loadedAt > 0;
  }

  get ageMs(): number {
    return Date.now() - this.loadedAt;
  }

  table(name: string): TableInfo | undefined {
    return this.tables.get(name);
  }

  tableNames(): string[] {
    return [...this.tables.keys()].sort();
  }

  foreignKeys(): readonly ForeignKey[] {
    return this.fks;
  }

  async load(): Promise<void> {
    const started = Date.now();
    const cols = await this.db<
      { table_name: string; table_type: string; column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null; is_generated: string }[]
    >`
      select c.table_name, t.table_type, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default, c.is_generated
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = ${this.schema}
      order by c.table_name, c.ordinal_position`;

    const keys = await this.db<{ table_name: string; constraint_type: string; constraint_name: string; columns: string[] }[]>`
      select tc.table_name, tc.constraint_type, tc.constraint_name,
             array_agg(kcu.column_name::text order by kcu.ordinal_position) as columns
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_schema = tc.constraint_schema and kcu.constraint_name = tc.constraint_name
       and kcu.table_name = tc.table_name
      where tc.table_schema = ${this.schema} and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
      group by tc.table_name, tc.constraint_type, tc.constraint_name`;

    // pg_constraint gives FK column order reliably (information_schema loses it for multi-column keys).
    const fkRows = await this.db<{ name: string; table: string; columns: string[]; ref_table: string; ref_columns: string[] }[]>`
      select con.conname as name,
             rel.relname as table,
             array(select att.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
                   join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum order by k.ord) as columns,
             frel.relname as ref_table,
             array(select att.attname::text from unnest(con.confkey) with ordinality k(attnum, ord)
                   join pg_attribute att on att.attrelid = con.confrelid and att.attnum = k.attnum order by k.ord) as ref_columns
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
      join pg_class frel on frel.oid = con.confrelid
      join pg_namespace fns on fns.oid = frel.relnamespace
      where con.contype = 'f' and ns.nspname = ${this.schema} and fns.nspname = ${this.schema}`;

    const tables = new Map<string, TableInfo>();
    for (const c of cols) {
      let t = tables.get(c.table_name);
      if (!t) {
        t = { name: c.table_name, isView: c.table_type === 'VIEW', columns: new Map(), primaryKey: [], uniques: [] };
        tables.set(c.table_name, t);
      }
      t.columns.set(c.column_name, {
        name: c.column_name,
        type: c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type,
        udt: c.udt_name,
        nullable: c.is_nullable === 'YES',
        hasDefault: c.column_default !== null,
        generated: c.is_generated === 'ALWAYS',
      });
    }
    for (const k of keys) {
      const t = tables.get(k.table_name);
      if (!t) continue;
      if (k.constraint_type === 'PRIMARY KEY') t.primaryKey = k.columns;
      t.uniques.push(k.columns);
    }
    // Unique indexes that are not constraints also qualify as on_conflict targets.
    const idx = await this.db<{ table: string; columns: string[] }[]>`
      select t.relname as table,
             array(select a.attname::text from unnest(i.indkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum order by k.ord) as columns
      from pg_index i
      join pg_class t on t.oid = i.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = ${this.schema} and i.indisunique and i.indpred is null and i.indexprs is null`;
    for (const u of idx) {
      const t = tables.get(u.table);
      if (t && !t.uniques.some((x) => x.join(',') === u.columns.join(','))) t.uniques.push(u.columns);
    }

    this.tables = tables;
    this.fks = fkRows.map((r) => ({ name: r.name, table: r.table, columns: r.columns, refTable: r.ref_table, refColumns: r.ref_columns }));
    this.loadedAt = Date.now();
    this.log.info({ tables: tables.size, foreignKeys: this.fks.length, ms: Date.now() - started }, 'schema cache loaded');
  }

  /** Reloads periodically so additive schema changes (new columns) are picked up without a restart. */
  startAutoRefresh(intervalMs = 5 * 60_000): () => void {
    const t = setInterval(() => {
      this.load().catch((e: unknown) => this.log.error({ err: e }, 'schema cache refresh failed'));
    }, intervalMs);
    t.unref();
    return () => clearInterval(t);
  }

  /** Test helper: install a hand-written schema without a database. */
  setForTests(tables: TableInfo[], fks: ForeignKey[]): void {
    this.tables = new Map(tables.map((t) => [t.name, t]));
    this.fks = fks;
    this.loadedAt = Date.now();
  }
}
