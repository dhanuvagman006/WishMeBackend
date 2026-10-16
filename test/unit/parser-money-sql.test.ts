import { describe, expect, it } from 'vitest';
import { parseLogic, parseOrder, parsePrefer, parseRead, parseSelect, splitTopLevel } from '../../src/compat/postgrest/parser.js';
import { fromRupees, positiveAmount, toRupeesString } from '../../src/lib/money.js';
import { and, ident, sql } from '../../src/lib/sql.js';

describe('PostgREST parser', () => {
  it('parses the select shapes the app uses', () => {
    expect(parseSelect('*,celebrity:celebrities!conversations_celebrity_id_fkey(id,name,image_url)')).toEqual([
      { kind: 'star' },
      {
        kind: 'embed',
        alias: 'celebrity',
        target: 'celebrities',
        hint: 'conversations_celebrity_id_fkey',
        inner: false,
        select: [
          { kind: 'column', name: 'id' },
          { kind: 'column', name: 'name' },
          { kind: 'column', name: 'image_url' },
        ],
      },
    ]);
    const nested = parseSelect('*,celebrity_occasions!inner(*,celebrities:celebrity_id(id,name))');
    expect(nested[1]).toMatchObject({ kind: 'embed', target: 'celebrity_occasions', inner: true });
    expect(parseSelect('*,celebrity_reviews(count)')[1]).toMatchObject({ select: [{ kind: 'count' }] });
  });

  it('parses filters, logic trees, order and prefer headers', () => {
    const r = parseRead(new URLSearchParams('select=id&status=eq.active&id=in.(a,"b,c")&deleted_at=not.is.null&order=created_at.desc.nullslast&limit=5'));
    expect(r.where).toEqual([
      { kind: 'cond', column: 'status', op: 'eq', negate: false, value: 'active' },
      { kind: 'cond', column: 'id', op: 'in', negate: false, value: ['a', 'b,c'] },
      { kind: 'cond', column: 'deleted_at', op: 'is', negate: true, value: 'null' },
    ]);
    expect(r.order).toEqual([{ column: 'created_at', dir: 'desc', nulls: 'last' }]);
    expect(r.limit).toBe(5);
    expect(parseLogic('or', false, '(consent_status.neq.rejected,consent_status.is.null)').items).toHaveLength(2);
    expect(parseOrder('name.asc')).toEqual([{ column: 'name', dir: 'asc' }]);
    expect(parsePrefer('return=representation, count=exact,resolution=merge-duplicates')).toMatchObject({
      returnRepresentation: true,
      count: 'exact',
      mergeDuplicates: true,
    });
  });

  it('rejects what it does not implement instead of ignoring it', () => {
    expect(() => parseRead(new URLSearchParams('name=fts.hello'))).toThrow();
    expect(() => parseRead(new URLSearchParams('profiles.first_name=eq.x'))).toThrow();
    expect(() => parseSelect('id::text')).toThrow();
    expect(() => parseSelect('na"me')).toThrow();
    expect(() => parseRead(new URLSearchParams('limit=-1'))).toThrow();
    expect(() => splitTopLevel('a,(b')).toThrow();
  });

  it('caps limits', () => {
    expect(parseRead(new URLSearchParams('limit=999999')).limit).toBe(1000);
  });
});

describe('money', () => {
  it('converts rupees and paise exactly', () => {
    expect(fromRupees('123.45')).toBe(12345);
    expect(fromRupees(0.1 + 0.2)).toBe(30);
    expect(fromRupees('-5')).toBe(-500);
    expect(toRupeesString(12345)).toBe('123.45');
    expect(toRupeesString(-5)).toBe('-0.05');
    expect(() => fromRupees('1.234')).toThrow();
    expect(() => fromRupees('abc')).toThrow();
  });

  it('validates client amounts', () => {
    expect(positiveAmount(100, { minRupees: 100 })).toBe(10000);
    expect(() => positiveAmount(0)).toThrow();
    expect(() => positiveAmount(99, { minRupees: 100 })).toThrow();
    expect(() => positiveAmount('1e9', { maxRupees: 100 })).toThrow();
  });
});

describe('sql builder', () => {
  it('parameterises values and quotes identifiers', () => {
    const q = and([sql`${ident('t0', 'user_id')} = ${'abc'}`, sql`${ident('t0', 'n')} > ${3}`]).toQuery();
    expect(q.text).toBe('(("t0"."user_id" = $1) and ("t0"."n" > $2))');
    expect(q.values).toEqual(['abc', 3]);
  });

  it('refuses identifiers that are not plain names', () => {
    expect(() => ident('users"; drop table x; --')).toThrow();
    expect(() => ident('a.b')).toThrow();
  });
});
