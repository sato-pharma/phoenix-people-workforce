// Master Map — "has anything actually changed?"
//
// The sheet polls every five minutes. That poll must not cost a full load of 52,614 rows, so this
// asks the cheap question first: how many live rows does each source table hold, and when was its
// newest write. Both are Postgres aggregates — no rows cross the Atlantic, and the whole probe is
// five parallel round trips.
//
// WHAT THIS DELIBERATELY DOES NOT CATCH, and why that is safe:
// none of the five source_of_sales_* tables has an update trigger — checked against production on
// 2026-08-17, pg_trigger returns nothing for all five — so `updated_at` moves only when
// application code sets it. It does on every normal write path (customer-map.ts and
// master-data/import-service.ts both stamp it), but hand-applied SQL is routine in this repo and
// would not. A row EDITED that way keeps its stamp and this probe would report "nothing changed".
//
// Additions and removals are caught regardless, because they move the row count — and additions
// are what the owner actually asked to see appear. For the rest, the sync forces a full content
// comparison once an hour whatever this says, so a missed edit self-heals within the hour instead
// of sitting stale forever. Cheap answer first, honest answer on a timer.

import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The five tables the Master Map is built from, and whether load.ts filters them to active rows. */
const SOURCE_TABLES = [
  { activeOnly: true, key: "customers", table: "source_of_sales_customer_map" },
  { activeOnly: true, key: "bricks", table: "source_of_sales_bricks" },
  { activeOnly: true, key: "areas", table: "source_of_sales_areas" },
  { activeOnly: true, key: "regions", table: "source_of_sales_regions" },
  { activeOnly: false, key: "distributors", table: "source_of_sales_distributors" },
] as const;

export type MasterMapStamp = string;

async function stampOne(entry: (typeof SOURCE_TABLES)[number]): Promise<string> {
  const supabase = getSupabaseAdmin();

  const countQuery = supabase.from(entry.table).select("*", { count: "exact", head: true });
  const newestQuery = supabase
    .from(entry.table)
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1);

  const [countResult, newestResult] = await Promise.all([
    entry.activeOnly ? countQuery.eq("active", true) : countQuery,
    entry.activeOnly ? newestQuery.eq("active", true) : newestQuery,
  ]);

  if (countResult.error) throw countResult.error;
  if (newestResult.error) throw newestResult.error;

  const newest = String(newestResult.data?.[0]?.updated_at ?? "never");
  return `${entry.key}:${countResult.count ?? 0}:${newest}`;
}

/**
 * A short opaque string that changes whenever the source data plausibly changed.
 *
 * Compared as a whole and never parsed by the caller — the shape is free to change, and a sync
 * that cannot read an older stamp simply treats it as different and repaints, which is the safe
 * direction to fail in.
 */
export async function readMasterMapStamp(): Promise<MasterMapStamp> {
  const parts = await Promise.all(SOURCE_TABLES.map((entry) => stampOne(entry)));
  return parts.join("|");
}
