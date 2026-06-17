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
