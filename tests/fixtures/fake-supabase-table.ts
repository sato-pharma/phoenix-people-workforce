/**
 * A minimal, in-memory stand-in for a Supabase/PostgREST query builder — NOT a mock that just
 * records calls, an actual tiny query engine. `.eq`/`.neq`/`.is`/`.gte`/`.lt`/`.lte`/`.in` apply as real
 * predicates against a shared, mutable row array; `.update` and `.insert` really mutate it. That
 * matters here specifically: the payroll copilot's "defer" mechanisms are money-safety code
 * (whether an outstation expense or a vacation settlement gets paid out this run), and this
 * repository's test suite runs with PRODUCTION Supabase credentials (`.env.local` points at
 * production) — so these functions can NEVER be exercised against a real client from a test.
 * Implements only the methods the payroll-copilot "defer" call sites actually use; deliberately
 * has no `.rpc`, `.auth`, `.storage`, etc. — anything reaching for those is a sign the function
 * under test grew a dependency this fixture was not built to cover.
 */

type FakeRow = Record<string, unknown>;

class FakeQueryBuilder {
  private rows: FakeRow[];
  private filters: Array<(row: FakeRow) => boolean> = [];
  private mode: "select" | "update" | "insert" = "select";
  private updatePayload: FakeRow | null = null;
  private insertPayload: FakeRow[] | null = null;
  private wantsSingle = false;

  constructor(rows: FakeRow[]) {
    this.rows = rows;
  }

  select(_columns?: string) {
    if (this.mode === "select") return this;
    // .insert(...).select("id") — the insert already set the mode; select() here just requests
    // the row back, it must not reset back to a plain read of the whole table.
    return this;
  }

  update(payload: FakeRow) {
    this.mode = "update";
    this.updatePayload = payload;
    return this;
  }

  insert(payload: FakeRow | FakeRow[]) {
    this.mode = "insert";
    this.insertPayload = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  single() {
    this.wantsSingle = true;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push((row) => String(row[column] ?? "") >= String(value));
    return this;
  }

  lte(column: string, value: unknown) {
    this.filters.push((row) => String(row[column] ?? "") <= String(value));
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push((row) => String(row[column] ?? "") < String(value));
    return this;
  }

  private matchIndexes(): number[] {
    const indexes: number[] = [];
    this.rows.forEach((row, index) => {
      if (this.filters.every((predicate) => predicate(row))) indexes.push(index);
    });
    return indexes;
  }

  // Makes the builder awaitable, exactly like the real supabase-js chain — `await` calls `.then`.
  then(
    resolve: (result: { data: unknown; error: null }) => void,
    _reject?: (reason: unknown) => void,
  ) {
    if (this.mode === "update") {
      for (const index of this.matchIndexes()) {
        Object.assign(this.rows[index], this.updatePayload);
      }
      resolve({ data: null, error: null });
      return;
    }
    if (this.mode === "insert") {
      const inserted: FakeRow[] = [];
      for (const row of this.insertPayload ?? []) {
        const stored = { id: `fake-${this.rows.length}-${inserted.length}`, ...row };
        this.rows.push(stored);
        inserted.push(stored);
      }
      resolve({ data: this.wantsSingle ? (inserted[0] ?? null) : inserted, error: null });
      return;
    }
    const matched = this.matchIndexes().map((index) => this.rows[index]);
    resolve({ data: this.wantsSingle ? (matched[0] ?? null) : matched, error: null });
  }
}

/**
 * A fake client exposing only `.from(table)`. Seed it with `{ tableName: [...rows] }`; read the
 * live state back afterwards with `.rows("tableName")` to assert on what a write actually did
 * (e.g. that exactly one row is left with `superseded_at: null`).
 */
export function fakeSupabaseClient(seed: Record<string, FakeRow[]> = {}) {
  const tables = new Map<string, FakeRow[]>(Object.entries(seed).map(([name, rows]) => [name, [...rows]]));

  return {
    from(name: string) {
      if (!tables.has(name)) tables.set(name, []);
      return new FakeQueryBuilder(tables.get(name) as FakeRow[]);
    },
    rows(name: string): FakeRow[] {
      return tables.get(name) ?? [];
    },
  };
}
