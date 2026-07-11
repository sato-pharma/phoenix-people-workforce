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
export async function selectAllRows(table: string, orderColumn?: string): Promise<Record<string, unknown>[]> {
  const supabase = getSupabaseAdmin();
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from(table).select("*").range(from, from + PAGE_SIZE - 1);
    if (orderColumn) query = query.order(orderColumn, { ascending: true });
    const { data, error } = await query;
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
