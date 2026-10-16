/**
 * Table policies: the allowlist that decides what the PostgREST-compatible surface may do. A table without a policy
 * does not exist as far as clients are concerned. Policies are plain data plus small functions, one file per domain
 * under ./policies, and every policy is validated against the live schema at startup (validatePolicies).
 *
 * Reads are expressed as grants. Each grant says which rows it covers and which columns it reveals in those rows. A row
 * is visible if any grant covers it; a column of that row is visible only if a covering grant lists it. Every column
 * reference (select, filters, order) uses the masked value, so a hidden column can neither be read nor probed with a
 * filter. Example: profiles reveals everything to the owner and only first_name/last_name/avatar_url to others.
 */
import type { AuthContext, Identity } from '../../auth/context.js';
import type { Sql } from '../../lib/sql.js';
import type { Prefer } from './ast.js';
import type { TableInfo } from './schema-cache.js';

export interface PolicyCtx {
  auth: AuthContext;
  identity: Identity;
  /** Qualified reference to a column of the row being evaluated (alias-aware). */
  col: (name: string) => Sql;
}

/** A row predicate. 'all' and 'none' are shortcuts that compile to true / false. */
export type RowRule = (c: PolicyCtx) => Sql | 'all' | 'none';

export interface ReadGrant {
  /** Short label used in logs and tests. */
  name: string;
  rows: RowRule;
  /** Columns revealed by this grant. '*' = every column except the table's hiddenColumns. */
  columns: readonly string[] | '*';
}

export interface WriteRule {
  rows?: RowRule;
  /** Columns the client may write. Others in the payload are rejected (or dropped with dropUnknown). */
  columns: readonly string[];
  /** Drop unknown keys instead of answering 400 (for screens that send whole objects back). */
  dropUnknown?: boolean;
  /** Values the server forces on every written row (owner ids, status). They override client values. */
  set?: (c: PolicyCtx) => Record<string, unknown>;
  /** Per-row validation or normalisation; throw an AppError to reject. May mutate the row. */
  check?: (row: Record<string, unknown>, c: PolicyCtx) => void | Promise<void>;
  /** Max rows per insert request (default 50). */
  maxRows?: number;
}

export interface CompatResult {
  status: number;
  /** JSON-serialisable body, or a pre-serialised JSON string. Undefined = empty body. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface CustomArgs {
  auth: AuthContext;
  identity: Identity;
  table: TableInfo;
  params: URLSearchParams;
  prefer: Prefer;
  body: unknown;
  /** True when the client asked for a single object (Accept: application/vnd.pgrst.object+json). */
  single: boolean;
}

/**
 * Replaces the generic engine for one method. Return 'default' to let the generic engine handle the request after all
 * (for example, a money table whose custom insert only intercepts credits).
 */
export type CustomHandler = (args: CustomArgs) => Promise<CompatResult | 'default'>;

export interface RealtimeRule {
  /** Columns a subscription may filter on (must be among the trigger's columns in migrations/0003). */
  filterColumns: readonly string[];
  /** May this caller subscribe to rows where `column = value`? */
  authorize: (auth: AuthContext, identity: Identity, column: string, value: string) => boolean | Promise<boolean>;
}

export interface TablePolicy {
  table: string;
  /** Columns never revealed, whatever the grant (password hashes, internal notes). */
  hiddenColumns?: readonly string[];
  read?: readonly ReadGrant[];
  insert?: WriteRule;
  update?: WriteRule & { rows: RowRule };
  delete?: { rows: RowRule };
  /** on_conflict targets accepted for upserts (each a column list). */
  upsertOn?: readonly (readonly string[])[];
  custom?: { read?: CustomHandler; insert?: CustomHandler; update?: CustomHandler; delete?: CustomHandler };
  realtime?: RealtimeRule;
  /** Public, cacheable reads (seconds). Only honoured for anonymous callers. */
  anonCacheSec?: number;
}

export interface RpcContext {
  auth: AuthContext;
  identity: Identity;
  args: Record<string, unknown>;
}

export interface RpcDefinition {
  name: string;
  /** 'anon' allows signed-out callers; 'user' requires a session. */
  access: 'anon' | 'user';
  handler: (c: RpcContext) => Promise<CompatResult>;
}

export function definePolicy(p: TablePolicy): TablePolicy {
  return p;
}

export function defineRpc(r: RpcDefinition): RpcDefinition {
  return r;
}

export class PolicyRegistry {
  private readonly tables = new Map<string, TablePolicy>();
  private readonly rpcs = new Map<string, RpcDefinition>();

  addTables(list: readonly TablePolicy[]): this {
    for (const p of list) {
      if (this.tables.has(p.table)) throw new Error(`Duplicate policy for table ${p.table}`);
      this.tables.set(p.table, p);
    }
    return this;
  }

  addRpcs(list: readonly RpcDefinition[]): this {
    for (const r of list) {
      if (this.rpcs.has(r.name)) throw new Error(`Duplicate RPC ${r.name}`);
      this.rpcs.set(r.name, r);
    }
    return this;
  }

  table(name: string): TablePolicy | undefined {
    return this.tables.get(name);
  }

  rpc(name: string): RpcDefinition | undefined {
    return this.rpcs.get(name);
  }

  allTables(): TablePolicy[] {
    return [...this.tables.values()];
  }
}
