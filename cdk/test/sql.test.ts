import { anyId, join, NOW, raw, set, sql, where } from '../lambda/endpoints/sql';

describe('sql', () => {
  it('turns values into placeholders', () => {
    const query = sql`SELECT * FROM t WHERE a = ${1} AND b = ${"it's"}`;
    expect(query.text).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(query.values).toEqual([1, "it's"]);
  });

  it('renumbers the placeholders of nested fragments', () => {
    const inner = sql`b = ${2} AND c = ${3}`;
    const query = sql`a = ${1} AND ${inner} AND d = ${4}`;
    expect(query.text).toBe('a = $1 AND b = $2 AND c = $3 AND d = $4');
    expect(query.values).toEqual([1, 2, 3, 4]);
  });

  it('splices fragments without values', () => {
    expect(sql`SELECT ${raw('x')} FROM t`.text).toBe('SELECT x FROM t');
    expect(sql`${raw('a')}${raw('b')}`.text).toBe('ab');
  });

  it('passes arrays and nulls as single values', () => {
    const query = sql`a = ANY(${[1, 2]}::int[]) AND b IS NOT DISTINCT FROM ${null}`;
    expect(query.text).toBe('a = ANY($1::int[]) AND b IS NOT DISTINCT FROM $2');
    expect(query.values).toEqual([[1, 2], null]);
  });
});

describe('join', () => {
  it('joins fragments with a separator', () => {
    const query = join([sql`a = ${1}`, sql`b = ${2}`], ' OR ');
    expect(query.text).toBe('a = $1 OR b = $2');
    expect(query.values).toEqual([1, 2]);
  });

  it('is empty for no fragments', () => {
    expect(join([], ', ').text).toBe('');
  });
});

describe('where', () => {
  it('ANDs the present conditions and skips falsy ones', () => {
    const query = sql`SELECT * FROM t${where([sql`a = ${1}`, undefined, '', false, sql`b = ${2}`])}`;
    expect(query.text).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(query.values).toEqual([1, 2]);
  });

  it('is empty without conditions', () => {
    expect(sql`SELECT * FROM t${where([undefined])}`.text).toBe('SELECT * FROM t');
  });
});

describe('set', () => {
  it('assigns defined fields, null as NULL, and Sql as an expression', () => {
    const query = sql`UPDATE t SET ${set({ a: 'x', b: undefined, c: null, d: sql`COALESCE(d, ${5})`, e: NOW })}`;
    expect(query.text).toBe('UPDATE t SET a = $1, c = $2, d = COALESCE(d, $3), e = NOW()');
    expect(query.values).toEqual(['x', null, 5]);
  });
});

describe('anyId', () => {
  it('matches the ids as one array value', () => {
    const query = anyId('l.listing_id', [3, 17]);
    expect(query.text).toBe('l.listing_id = ANY($1::int[])');
    expect(query.values).toEqual([[3, 17]]);
  });

  it('matches nothing for no ids', () => {
    expect(anyId('listing_id', []).text).toBe('FALSE');
  });
});
