/**
 * Counting the rows D1 reads and writes for a piece of work, as D1 itself counts them (index entries
 * included), so a member's daily budget can be charged by what their changes cost rather than by how
 * many requests they made. Covers what the server uses: prepare, bind, first, all, run, and batch.
 */

export interface Usage {
  read: number;
  written: number;
  /** Every statement run, when a test asks for them (COST_HEADERS). */
  sql?: Set<string>;
}

const INNER = Symbol("statement");

type Meta = { rows_read?: number; rows_written?: number } | undefined;

/** `db`, with every statement's rows added to `usage`. */
export function meter(db: D1Database, usage: Usage): D1Database {
  const add = (meta: Meta) => {
    usage.read += meta?.rows_read ?? 0;
    usage.written += meta?.rows_written ?? 0;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      [INNER]: statement,
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      // `first` gives no counts, so it reads the same statement with `all`, which D1 runs in full either way.
      async first(column?: string) {
        const result = await statement.all();
        add(result.meta as Meta);
        const row = (result.results[0] ?? null) as Record<string, unknown> | null;
        return column === undefined ? row : (row?.[column] ?? null);
      },
      async all() {
        const result = await statement.all();
        add(result.meta as Meta);
        return result;
      },
      async run() {
        const result = await statement.run();
        add(result.meta as Meta);
        return result;
      },
      raw: (...args: unknown[]) => (statement.raw as (...rest: unknown[]) => unknown)(...args),
    };
    return wrapped as unknown as D1PreparedStatement;
  };
  const unwrap = (statement: D1PreparedStatement) => (statement as unknown as { [INNER]?: D1PreparedStatement })[INNER] ?? statement;
  const metered = {
    prepare: (sql: string) => {
      usage.sql?.add(sql);
      return wrap(db.prepare(sql));
    },
    async batch(statements: D1PreparedStatement[]) {
      const results = await db.batch(statements.map(unwrap));
      for (const result of results) add(result.meta as Meta);
      return results;
    },
    exec: (sql: string) => db.exec(sql),
  };
  return metered as unknown as D1Database;
}
