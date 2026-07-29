import { getSupabaseAdmin } from "@/lib/supabase/server";

import { MASTER_DEFINITIONS, type MasterKey, type MasterRowRecord } from "./definitions";

export type { MasterRowRecord };

const PAGE_SIZE = 1000;

// Paginates past PostgREST's default row cap so a master/reference table (regions, areas, blocks,
// bricks, products, distributors) can never be silently truncated as it grows — a bare
// .select("*") with no .range()/.limit() would otherwise cap at ~1000 rows with no error and no
// indication to the caller that rows were dropped. A simple sequential walk is enough here (unlike
// the concurrent-fetch pattern used for transaction-scale tables elsewhere): master tables are
// reference-scale, not import-log-scale.
//
// `orderColumn` is REQUIRED, and that is the whole point. Postgres gives no stable row order without
// ORDER BY, so offset paging over an unordered result silently returns some rows twice and drops
// others — at random, differently on every run. It used to be optional and one caller omitted it;
// harmless only while every master fitted in a single page, but source_of_sales_bricks was 1,142
// rows as recently as 2026-07-28. Pass the table's key column.
export async function selectAllRows(table: string, orderColumn: string): Promise<Record<string, unknown>[]> {
  const supabase = getSupabaseAdmin();
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...(page as Record<string, unknown>[]));
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Lists every row of a master table (service-role read), ordered by key. */
export async function listMasterRows(master: MasterKey): Promise<MasterRowRecord[]> {
  const definition = MASTER_DEFINITIONS[master];
  const rows = await selectAllRows(definition.table, definition.keyColumn);
  return rows as MasterRowRecord[];
}
