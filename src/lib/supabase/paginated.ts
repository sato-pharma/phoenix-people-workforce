/**
 * Pages through a Supabase table/view query until all rows are fetched.
 *
 * PostgREST caps every response at db-max-rows (default 1000). Pass a
 * `buildQuery` factory — called once per page with `.range()` appended —
 * and all rows are returned as a flat array.
 *
 * For set-returning RPCs use `rpcAll` in server.ts instead: those cannot
 * be efficiently paginated with .range() because the function body re-runs
 * for every page.
 */
export async function fetchAllRows<T = Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: () => any,
  pageSize = 1000,
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await buildQuery().range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []) as T[];
    results.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return results;
}

/**
 * Same as {@link fetchAllRows}, but the sort column is a REQUIRED argument and is applied here
 * rather than by the caller.
 *
 * That difference is the whole point. Offset paging across several statements is only exact when
 * the rows come back in a stable order, and `fetchAllRows` cannot enforce that — its `buildQuery`
 * factory is opaque, so an unordered caller silently gets duplicated/skipped rows as pages shift.
 * This repo has already paid for that twice (1,262 lost customer→brick mappings; see
 * `tests/sos-crosswalk-pagination.test.ts`, and the mandatory `orderColumn` on
 * `src/lib/sales/master-data/list.ts`'s selectAllRows).
 *
 * Prefer this over `fetchAllRows` for any new full-table read. Use a column that is unique (or
 * near-unique) so the order is total; for a large, growing table prefer a keyset scan instead
 * (see `keysetScanVisitsForRange` in src/lib/crm/reads.ts).
 */
export async function fetchAllRowsOrdered<T = Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: () => any,
  orderColumn: string,
  pageSize = 1000,
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await buildQuery()
      .order(orderColumn, { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []) as T[];
    results.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return results;
}
