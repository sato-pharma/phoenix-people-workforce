// Master Map — "has anything actually changed?"
//
// The sheet polls every five minutes. That poll must not cost a full load of 52,614 rows, so this
// asks the cheap question first: how many live rows does each source table hold, and when was its
// newest write. Both are Postgres aggregates, so none of the 52,614 customer rows crosses the
// Atlantic. The organogram is the one exception and reads its rows — see stampOrganogram for why a
// count cannot answer the question there. Seven parallel round trips in all.
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

/** FNV-1a, so a few hundred short strings collapse to one eight-character stamp. */
function foldToHash(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The organogram: which district owns each area, and who sits in each district's seat.
 *
 * Watched here because it has no other source. Nothing in source_of_sales_* moves when the owner
 * shifts an area between districts or gives a district a new manager, so without this the change
 * would sit invisible until the hourly full check. Upper Egypt 1 and Upper Egypt 2 are built
 * entirely from it, and every tab now carries its district managers.
 *
 * THIS ONE READS ROWS, unlike the five above, and that is deliberate. A count-and-newest-date stamp
 * cannot see a manager change at all: replacing the person in a seat rewrites no row of the area map
 * and moves no `effective_from`, so the count and the date both come back identical while every
 * manager cell in the workbook is now wrong. The rows are what changed, so the rows are what has to
 * be looked at. It is affordable because the organogram is small — 147 area rows and 133 seats
 * today, two columns each, against 52,614 customers — and they fold into an eight-character hash.
 *
 * Still misses one thing: renaming a PERSON in `employees` without touching their seat. The hourly
 * full comparison catches that, the same way it catches a hand-edited SoS row above.
 *
 * Fails soft to a fixed marker: the organogram must never be able to stop the workbook refreshing.
 */
async function stampOrganogram(): Promise<string> {
  try {
    const supabase = getSupabaseAdmin();
    const [areasResult, seatsResult] = await Promise.all([
      supabase
        .from("au_v_line_area_map")
        .select("area_code,line_code,operational_region_code,dm_seat_id,effective_from,effective_to"),
      supabase.from("au_v_org_tree").select("seat_id,occupant_hr_id,is_other_pseudo_dm"),
    ]);
    if (areasResult.error || seatsResult.error) return "organogram:unreadable";

    const areas = (areasResult.data ?? []) as Array<Record<string, unknown>>;
    const seats = (seatsResult.data ?? []) as Array<Record<string, unknown>>;

    // Sorted, because PostgREST makes no ordering promise without an ORDER BY and a stamp that
    // moves when the rows merely come back in another order would repaint the workbook for nothing.
    const parts = [
      ...areas.map((row) =>
        [
          row.area_code,
          row.line_code,
          row.operational_region_code,
          row.dm_seat_id,
          row.effective_from,
          row.effective_to,
        ].join(""),
      ),
      ...seats.map((row) =>
        [row.seat_id, row.occupant_hr_id, row.is_other_pseudo_dm].join(""),
      ),
    ].sort();

    return `organogram:${areas.length}:${seats.length}:${foldToHash(parts)}`;
  } catch {
    return "organogram:unreadable";
  }
}

/**
 * A short opaque string that changes whenever the source data plausibly changed.
 *
 * Compared as a whole and never parsed by the caller — the shape is free to change, and a sync
 * that cannot read an older stamp simply treats it as different and repaints, which is the safe
 * direction to fail in.
 */
export async function readMasterMapStamp(): Promise<MasterMapStamp> {
  const parts = await Promise.all([
    ...SOURCE_TABLES.map((entry) => stampOne(entry)),
    stampOrganogram(),
  ]);
  return parts.join("|");
}
