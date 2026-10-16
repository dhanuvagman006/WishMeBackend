/** The parsed form of a PostgREST request. Produced by parser.ts, consumed by compiler.ts. */

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in';

export interface Condition {
  kind: 'cond';
  column: string;
  op: FilterOp;
  negate: boolean;
  /** For `is`: 'null' | 'true' | 'false' | 'unknown'. For `in`: string[]. Otherwise a string. */
  value: string | string[];
}

export interface Group {
  kind: 'group';
  op: 'and' | 'or';
  negate: boolean;
  items: Filter[];
}

export type Filter = Condition | Group;

export interface ColumnItem {
  kind: 'column';
  name: string;
  alias?: string;
}

export interface StarItem {
  kind: 'star';
}

export interface EmbedItem {
  kind: 'embed';
  /** Table name, or a foreign-key column of the parent (`celebrities:celebrity_id(...)`). */
  target: string;
  alias?: string;
  /** `!constraint_name`, `!fk_column` or `!inner` / `!left`. */
  hint?: string;
  inner: boolean;
  select: SelectItem[];
}

export interface CountItem {
  kind: 'count';
}

export type SelectItem = ColumnItem | StarItem | EmbedItem | CountItem;

export interface OrderItem {
  column: string;
  dir: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

export interface ReadRequest {
  select: SelectItem[];
  where: Filter[];
  order: OrderItem[];
  limit?: number;
  offset?: number;
}

export interface Prefer {
  returnRepresentation: boolean;
  returnMinimal: boolean;
  count: 'exact' | 'planned' | 'estimated' | null;
  mergeDuplicates: boolean;
  ignoreDuplicates: boolean;
}
