/**
 * Parses PostgREST query strings into an AST. Deliberately strict: an operator, parameter or syntax this server does
 * not implement is a 400 with PostgREST's error shape, never silently ignored (an ignored filter would widen a read).
 */
import { AppError } from '../../lib/errors.js';
import type { Condition, EmbedItem, Filter, FilterOp, Group, OrderItem, Prefer, ReadRequest, SelectItem } from './ast.js';

/** Query parameters with a meaning of their own; every other parameter is a column filter. */
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and', 'not.or', 'not.and']);
const OPS = new Set<FilterOp>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const MAX_IN = 500;
const MAX_LIMIT = 1000;

export const pgrstError = (status: number, code: string, message: string, details?: string, hint?: string) =>
  new AppError(status, code, message, details ?? null, hint);

const parseError = (message: string, details?: string) => pgrstError(400, 'PGRST100', message, details);

function checkName(name: string, what: string): string {
  if (!NAME.test(name)) throw parseError(`"failed to parse ${what}"`, `Unexpected "${name}"`);
  return name;
}

/** Splits on `sep` at nesting depth 0, respecting parentheses and double quotes. */
export function splitTopLevel(input: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '"' && input[i - 1] !== '\\') quoted = !quoted;
    if (!quoted) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth < 0) throw parseError('Unbalanced parentheses');
      if (ch === sep && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (depth !== 0 || quoted) throw parseError('Unbalanced parentheses or quotes');
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

const unquote = (v: string) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\"/g, '"') : v);

// ── select ───────────────────────────────────────────────────────────────────────────────────────────────────

export function parseSelect(raw: string | undefined, depth = 0): SelectItem[] {
  if (raw === undefined || raw.trim() === '') return [{ kind: 'star' }];
  if (depth > 3) throw parseError('Embedding is limited to three levels');
  return splitTopLevel(raw).map((item) => parseSelectItem(item, depth));
}

function parseSelectItem(item: string, depth: number): SelectItem {
  if (item === '*') return { kind: 'star' };
  if (item === 'count' || item === 'count()') return { kind: 'count' };
  const open = item.indexOf('(');
  if (open >= 0) {
    if (!item.endsWith(')')) throw parseError('failed to parse select parameter', item);
    const head = item.slice(0, open);
    const inside = item.slice(open + 1, -1);
    let alias: string | undefined;
    let rest = head;
    const colon = head.indexOf(':');
    if (colon >= 0) {
      alias = checkName(head.slice(0, colon), 'embed alias');
      rest = head.slice(colon + 1);
    }
    const [target, ...hints] = rest.split('!');
    const embed: EmbedItem = {
      kind: 'embed',
      target: checkName(target ?? '', 'embedded resource'),
      inner: false,
      select: parseSelect(inside, depth + 1),
    };
    if (alias) embed.alias = alias;
    for (const h of hints) {
      if (h === 'inner') embed.inner = true;
      else if (h === 'left') embed.inner = false;
      else embed.hint = checkName(h, 'embed hint');
    }
    return embed;
  }
  if (item.includes('::') || item.includes('->')) throw parseError('Casts and JSON paths are not supported', item);
  const colon = item.indexOf(':');
  if (colon >= 0) {
    return { kind: 'column', alias: checkName(item.slice(0, colon), 'column alias'), name: checkName(item.slice(colon + 1), 'column') };
  }
  return { kind: 'column', name: checkName(item, 'column') };
}

// ── filters ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Parses the value part of `col=op.value` (or `not.op.value`). */
export function parseCondition(column: string, expr: string): Condition {
  let rest = expr;
  let negate = false;
  if (rest.startsWith('not.')) {
    negate = true;
    rest = rest.slice(4);
  }
  const dot = rest.indexOf('.');
  if (dot < 0) throw parseError(`"failed to parse filter (${expr})"`, `Missing operator for ${column}`);
  const op = rest.slice(0, dot) as FilterOp;
  const value = rest.slice(dot + 1);
  if (!OPS.has(op)) throw parseError(`"failed to parse filter (${expr})"`, `Unsupported operator "${op}"`);
  if (op === 'in') {
    if (!value.startsWith('(') || !value.endsWith(')')) throw parseError(`"failed to parse filter (${expr})"`, 'in. needs (a,b,…)');
    const list = splitTopLevel(value.slice(1, -1)).map(unquote);
    if (list.length > MAX_IN) throw parseError(`in. lists are limited to ${MAX_IN} values`);
    return { kind: 'cond', column: checkName(column, 'filter column'), op, negate, value: list };
  }
  if (op === 'is') {
    const v = value.toLowerCase();
    if (!['null', 'true', 'false', 'unknown'].includes(v)) throw parseError(`"failed to parse filter (${expr})"`, 'is. accepts null, true, false or unknown');
    return { kind: 'cond', column: checkName(column, 'filter column'), op, negate, value: v };
  }
  return { kind: 'cond', column: checkName(column, 'filter column'), op, negate, value: unquote(value) };
}

/** Parses `(a.eq.1,b.is.null,and(c.gt.2,d.lt.3))` as used by `or=` / `and=`. */
export function parseLogic(op: 'and' | 'or', negate: boolean, raw: string, depth = 0): Group {
  if (depth > 4) throw parseError('Logic trees are limited to four levels');
  if (!raw.startsWith('(') || !raw.endsWith(')')) throw parseError(`"failed to parse logic tree (${raw})"`);
  const items: Filter[] = splitTopLevel(raw.slice(1, -1)).map((part) => {
    const m = /^(not\.)?(and|or)(\(.*\))$/s.exec(part);
    if (m) return parseLogic(m[2] as 'and' | 'or', !!m[1], m[3]!, depth + 1);
    const dot = part.indexOf('.');
    if (dot < 0) throw parseError(`"failed to parse logic tree (${raw})"`, part);
    return parseCondition(part.slice(0, dot), part.slice(dot + 1));
  });
  return { kind: 'group', op, negate, items };
}

export function parseOrder(raw: string | undefined): OrderItem[] {
  if (!raw) return [];
  return splitTopLevel(raw).map((part) => {
    const [col, ...mods] = part.split('.');
    const item: OrderItem = { column: checkName(col ?? '', 'order column'), dir: 'asc' };
    for (const m of mods) {
      if (m === 'asc' || m === 'desc') item.dir = m;
      else if (m === 'nullsfirst') item.nulls = 'first';
      else if (m === 'nullslast') item.nulls = 'last';
      else throw parseError(`"failed to parse order (${raw})"`, `Unexpected "${m}"`);
    }
    return item;
  });
}

function parseIntParam(raw: string | undefined, name: string, max: number): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) throw parseError(`"${name}" must be a non-negative integer`);
  return Math.min(Number(raw), max);
}

/**
 * Turns a URLSearchParams into a read request. Embedded-resource filters (`embed.col=…`) are rejected: the app does not
 * use them and silently ignoring one would return more rows than asked for.
 */
export function parseRead(params: URLSearchParams): ReadRequest {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key) && RESERVED.has(key)) throw parseError(`Parameter "${key}" given more than once`);
    seen.add(key);
  }
  const where: Filter[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'or' || key === 'and' || key === 'not.or' || key === 'not.and') {
      const neg = key.startsWith('not.');
      where.push(parseLogic(key.replace('not.', '') as 'and' | 'or', neg, value));
      continue;
    }
    if (RESERVED.has(key)) continue;
    if (key.includes('.')) throw parseError(`Filters on embedded resources are not supported (${key})`);
    where.push(parseCondition(key, value));
  }
  const req: ReadRequest = {
    select: parseSelect(params.get('select') ?? undefined),
    where,
    order: parseOrder(params.get('order') ?? undefined),
  };
  const limit = parseIntParam(params.get('limit') ?? undefined, 'limit', MAX_LIMIT);
  const offset = parseIntParam(params.get('offset') ?? undefined, 'offset', 1_000_000);
  if (limit !== undefined) req.limit = limit;
  if (offset !== undefined) req.offset = offset;
  return req;
}

export function parsePrefer(header: string | string[] | undefined): Prefer {
  const all = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const count = all.find((p) => p.startsWith('count='))?.slice(6) ?? null;
  return {
    returnRepresentation: all.includes('return=representation'),
    returnMinimal: all.includes('return=minimal'),
    count: count === 'exact' || count === 'planned' || count === 'estimated' ? count : null,
    mergeDuplicates: all.includes('resolution=merge-duplicates'),
    ignoreDuplicates: all.includes('resolution=ignore-duplicates'),
  };
}

export function parseOnConflict(raw: string | null): string[] | null {
  if (!raw) return null;
  return raw.split(',').map((c) => checkName(c.trim(), 'on_conflict column'));
}
