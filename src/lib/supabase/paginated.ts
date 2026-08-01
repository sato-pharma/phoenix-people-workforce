/**
 * Helpers for reading a table/view in full.
 *
 * PostgREST caps every response at db-max-rows (default 1000), so any read that can exceed that
 * MUST page. Two things have gone wrong here before, both silently:
 *
 *  - an offset walk with no stable ORDER BY loses and duplicates rows between pages (#1446 lost
 *    1,262 of 49,713 customer mappings, and the symptom looked like a bad source sheet);
 *  - a hard row ceiling (`for (from = 0; from < MAX; …)`) truncates a real dataset at the cap. With
 *    an ascending id walk that always discards the NEWEST rows, so the most recently corrected
 *    mappings are exactly the ones that disappear.
 *
 * `fetchAllRows` now REQUIRES a tiebreak column so the first cannot happen, and neither helper
 * takes a maximum so the second cannot either.
 *
 * HISTORY, so nobody re-adds the third variant: `main` independently fixed the same unordered-paging
 * bug by adding `fetchAllRowsOrdered(buildQuery, orderColumn)` alongside a permissive
 * `fetchAllRows(buildQuery)`. That is behaviourally identical to the `fetchAllRows` below — both do
 * `.order(col, asc).range(...)` — so on merge the two were collapsed into this one function and its
 * callers renamed. Owner ruling 2026-08-01: the KEYSET pager is the surviving abstraction for new
 * full-table reads; the offset pager stays only for reads whose order column is not monotonic.
 *
 * For set-returning RPCs use `rpcAll` in server.ts instead: those cannot be efficiently paginated
 * with .range() because the function body re-runs for every page.
 */

/**
 * Offset pager. `tiebreakColumn` is appended as the LAST order key, so a caller's own ordering
 * still wins and this only guarantees a total order across pages. Prefer `fetchAllRowsKeyset` for
 * tables that are written while being read.
 */
export async function fetchAllRows<T = Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: () => any,
  tiebreakColumn: string,
  pageSize = 1000,
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await buildQuery()
      .order(tiebreakColumn, { ascending: true })
      .range(offset, offset + pageSize - 1);
    // Never treat an error as end-of-data — that turns a transient failure into a silently short
    // result that reads as real.
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []) as T[];
    results.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return results;
}

/**
 * Keyset (seek) pager over a monotonic column — the shape established by selectAllActive in
 * src/lib/sales/normalizer/crosswalks.ts.
 *
 * Immune to concurrent inserts and deletes, which an offset walk is not: with `.range()` a row
 * inserted before the cursor shifts every later page by one and one row is never returned. Use this
 * for anything read while imports may be writing (customer map, import rows, crosswalks).
 *
 * `buildQuery(cursor)` must return a query already filtered and selected; this appends the ordering,
 * the cursor predicate and the limit.
 */
export async function fetchAllRowsKeyset<T = Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: () => any,
  options: {
    /** Monotonic, unique column to seek on — normally the bigint primary key. */
    cursorColumn: string;
    /** Reads the cursor value out of a row. */
    cursorOf: (row: T) => number | string | null | undefined;
    pageSize?: number;
  },
): Promise<T[]> {
  const { cursorColumn, cursorOf, pageSize = 1000 } = options;
  const results: T[] = [];
  let cursor: number | string | null = null;

  while (true) {
    let query = buildQuery().order(cursorColumn, { ascending: true }).limit(pageSize);
    if (cursor !== null) query = query.gt(cursorColumn, cursor);
    const { data, error } = await query;
    if (error) throw error;

    const rows = (Array.isArray(data) ? data : []) as T[];
    if (rows.length === 0) break;
    results.push(...rows);
    if (rows.length < pageSize) break;

    const next = cursorOf(rows[rows.length - 1]);
    // A missing or non-advancing cursor would loop forever — stop rather than spin.
    if (next === null || next === undefined) break;
    if (cursor !== null && next === cursor) break;
    cursor = next;
  }

  return results;
}
