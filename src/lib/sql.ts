/**
 * A tiny, safe SQL builder. Values always become numbered parameters ($1, $2 …); identifiers are only produced by
 * `ident()`, which quotes them, and callers only pass names that were validated against the schema cache or a
 * hard-coded allowlist. Nothing here concatenates user input into SQL text.
 *
 *   const q = sql`select ${ident('name')} from ${ident('public', 'celebrities')} where id = ${id}`;
 *   q.toQuery() // { text: 'select "name" from "public"."celebrities" where id = $1', values: [id] }
 */

const IDENT = Symbol('ident');
const RAW = Symbol('raw');

interface Ident {
  [IDENT]: string;
}
interface Raw {
  [RAW]: string;
}

type Part = string | Ident | Raw | Sql | { value: unknown };

export class Sql {
  constructor(readonly parts: readonly Part[]) {}

  /** Renders the fragment with placeholders starting after `offset` existing values. */
  toQuery(offset = 0): { text: string; values: unknown[] } {
    const values: unknown[] = [];
    const render = (parts: readonly Part[]): string =>
      parts
        .map((p) => {
          if (typeof p === 'string') return p;
          if (p instanceof Sql) return render(p.parts);
          if (IDENT in p) return p[IDENT];
          if (RAW in p) return p[RAW];
          values.push(p.value);
          return `$${offset + values.length}`;
        })
        .join('');
    const text = render(this.parts);
    return { text, values };
  }

  isEmpty(): boolean {
    return this.parts.every((p) => (typeof p === 'string' ? p.trim() === '' : p instanceof Sql ? p.isEmpty() : false));
  }
}

/** Tagged template: interpolated Sql fragments and identifiers are inlined, anything else becomes a parameter. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  const parts: Part[] = [];
  strings.forEach((s, i) => {
    if (s) parts.push(s);
    if (i < values.length) {
      const v = values[i];
      if (v instanceof Sql || isIdent(v) || isRaw(v)) parts.push(v as Part);
      else parts.push({ value: v });
    }
  });
  return new Sql(parts);
}

function isIdent(v: unknown): v is Ident {
  return typeof v === 'object' && v !== null && IDENT in v;
}
function isRaw(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && RAW in v;
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** A quoted identifier, optionally schema-qualified. Throws on names that could never be real identifiers. */
export function ident(...names: string[]): Sql {
  for (const n of names) {
    if (!SAFE_NAME.test(n)) throw new Error(`Refusing unsafe identifier: ${JSON.stringify(n)}`);
  }
  return new Sql([{ [IDENT]: names.map((n) => `"${n}"`).join('.') }]);
}

/** Trusted constant SQL text (keywords, operators chosen from a fixed table). Never pass user input. */
export function raw(text: string): Sql {
  return new Sql([{ [RAW]: text }]);
}

export function join(fragments: readonly Sql[], separator = ', '): Sql {
  const parts: Part[] = [];
  fragments.forEach((f, i) => {
    if (i > 0) parts.push(separator);
    parts.push(f);
  });
  return new Sql(parts);
}

export function and(fragments: readonly (Sql | null | undefined)[]): Sql {
  const present = fragments.filter((f): f is Sql => !!f && !f.isEmpty());
  if (present.length === 0) return sql`true`;
  if (present.length === 1) return present[0]!;
  return sql`(${join(present.map((f) => sql`(${f})`), ' and ')})`;
}

export function or(fragments: readonly (Sql | null | undefined)[]): Sql {
  const present = fragments.filter((f): f is Sql => !!f && !f.isEmpty());
  if (present.length === 0) return sql`false`;
  if (present.length === 1) return present[0]!;
  return sql`(${join(present.map((f) => sql`(${f})`), ' or ')})`;
}

export const TRUE = sql`true`;
export const FALSE = sql`false`;
