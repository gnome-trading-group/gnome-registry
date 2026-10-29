// A query whose values travel separately from its text, as pg's { text, values } query config. Values never become
// SQL, so nothing they contain needs quoting or escaping.
export class Sql {
  readonly text: string;
  readonly values: unknown[];

  constructor(readonly parts: readonly string[], values: readonly unknown[]) {
    this.values = [...values];
    this.text = parts.reduce((text, part, i) => `${text}$${i}${part}`);
  }
}

/**
 * Interpolated values become $n placeholders; an interpolated Sql is spliced in with its placeholders renumbered, so
 * fragments compose.
 */
export function sql(template: TemplateStringsArray, ...args: unknown[]): Sql {
  const parts = [template[0]];
  const values: unknown[] = [];
  args.forEach((arg, i) => {
    if (arg instanceof Sql) {
      parts[parts.length - 1] += arg.parts[0];
      parts.push(...arg.parts.slice(1));
      values.push(...arg.values);
    } else {
      values.push(arg);
      parts.push('');
    }
    parts[parts.length - 1] += template[i + 1];
  });
  return new Sql(parts, values);
}

/** Text spliced into the query as is: identifiers and keywords from code, never a caller's value. */
export function raw(text: string): Sql {
  return new Sql([text], []);
}

export const NOW = raw('NOW()');

export function join(fragments: Sql[], separator: string): Sql {
  return fragments.reduce((joined, fragment, i) => (i === 0 ? fragment : sql`${joined}${raw(separator)}${fragment}`), raw(''));
}

/** A WHERE clause of the conditions given, or nothing when there are none. Falsy entries are skipped, so a filter can
 *  be written as `params.x && sql\`...\``. */
export function where(conditions: unknown[]): Sql {
  const present = conditions.filter((c): c is Sql => c instanceof Sql);
  return present.length > 0 ? sql` WHERE ${join(present, ' AND ')}` : raw('');
}

/** The column is one of these ids; matches nothing rather than everything when the list is empty. */
export function anyId(column: string, ids: number[]): Sql {
  return ids.length > 0 ? sql`${raw(column)} = ANY(${ids}::int[])` : raw('FALSE');
}

/** `col = value, ...` for an UPDATE: undefined fields are left out, null sets NULL, and an Sql value is an expression. */
export function set(fields: Record<string, unknown>): Sql {
  const assignments = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([column, value]) => sql`${raw(column)} = ${value}`);
  return join(assignments, ', ');
}
