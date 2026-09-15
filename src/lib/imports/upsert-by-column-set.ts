// ─────────────────────────────────────────────────────────────────────────────────────────────
// Bulk upserts that never write a column a row left blank.
//
// @supabase/postgrest-js sends a bulk upsert as ONE request with ONE column list: the union of
// every row's keys (the `columns=` URL parameter). PostgREST fills any listed column a row does not
// carry with NULL, and with `onConflict` that NULL is merged over the stored value. So a single row
// that fills a cell erases the same cell on every other row in the request that left it blank.
//
// The employee importer builds each row with conditional spreads for exactly this reason — a blank
// spreadsheet cell is meant to leave what is saved alone — and one bulk call quietly undid that for
// every column any other row in the file happened to fill. `defaultToNull: false` does not rescue
// it: on a merge the column default still replaces the stored value.
//
// The fix is structural rather than per column: send rows in groups that carry exactly the same
// keys, so each request's column list is true for every row in it. Pure apart from the injected
// `write`, so it is testable against the real client with a stubbed fetch.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `rows` split into groups whose rows carry exactly the same keys, in first-seen order.
 *
 * A key whose value is `undefined` counts as absent and is dropped from the row: JSON would leave it
 * out of the body anyway, but postgrest-js would still list it as a column, and PostgREST would then
 * write NULL for it.
 */
export function groupRowsByColumnSet<Row extends object>(rows: readonly Row[]): Row[][] {
  const groups = new Map<string, Row[]>();

  for (const row of rows) {
    const carried = Object.fromEntries(
      Object.entries(row).filter(([, value]) => value !== undefined),
    ) as Row;
    const columnSet = Object.keys(carried).sort().join("\n");
    const group = groups.get(columnSet);

    if (group) {
      group.push(carried);
    } else {
      groups.set(columnSet, [carried]);
    }
  }

  return Array.from(groups.values());
}

/**
 * Upsert `rows` one column-set group at a time, so no request names a column one of its rows left
 * blank.
 *
 * Stops at the first failing group and returns its error. Groups written before it stay written:
 * each write is an idempotent upsert, so running the same import again converges on the same rows.
 */
export async function upsertByColumnSet<Row extends object, Failure extends { message: string }>(
  rows: readonly Row[],
  write: (group: Row[]) => PromiseLike<{ error: Failure | null }>,
): Promise<{ error: Failure | null }> {
  for (const group of groupRowsByColumnSet(rows)) {
    const { error } = await write(group);

    if (error) {
      return { error };
    }
  }

  return { error: null };
}
