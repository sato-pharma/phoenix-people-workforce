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
import { ORGANOGRAM_ROW_CAP } from "@/lib/sales/master-map/organogram-limits";

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

  // `.limit(1)` changes nothing about the count and removes a second full scan. PostgREST answers
  // `count: "exact"` from its own count of the WHOLE filtered table, and separately counts the page
  // it would have returned — which, with no limit, is the whole table again, even for a HEAD that
  // returns no rows. On the customer map that second scan took 28.8 ms of a 145 ms probe
  // (production EXPLAIN, 2026-09-17); limiting the page to one row leaves the exact count, and so
  // the stamp, identical.
  const countQuery = supabase.from(entry.table).select("*", { count: "exact", head: true }).limit(1);
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
 * The boundary between two fields, and between two rows.
 *
 * Written as a char code on purpose. It used to be typed literally between the quotes, where it is
 * a RAW CONTROL BYTE that renders as nothing at all — so the line read as `.join("")` in every
 * diff, review and terminal, and the separator looked absent when it was in fact there. A reviewer
 * acting on that reading would "fix" a bug that did not exist, or a formatter could strip the byte
 * and silently introduce the one that did not. Naming it costs nothing and can be seen.
 *
 * Value unchanged, deliberately: it feeds the stamp, so a different character would repaint the
 * whole workbook once for no reason.
 */
const FIELD_SEPARATOR = String.fromCharCode(1);

/**
 * FNV-1a, so a few hundred short strings collapse to one eight-character stamp.
 *
 * The separator goes between the PARTS as well as inside them. Each part already separates its own
 * fields, but the fold ran them together, so two different lists of rows could stream the same
 * bytes into the hash — `["AB", "C"]` and `["A", "BC"]` are indistinguishable once concatenated.
 * That is a real change reported as no change, invisible until the hourly full comparison. One
 * boundary per part closes it; `hashValues` in payload.ts closes the same hole with JSON.stringify.
 */
function foldToHash(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  const fold = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const part of parts) {
    fold(part);
    fold(FIELD_SEPARATOR);
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
 * FAILS SOFT TO THE LAST GOOD STAMP, NOT TO A MARKER. The organogram must never be able to stop the
 * workbook refreshing — but a fixed "unreadable" marker is not neutral either, because it DIFFERS
 * from the stamp before it. A single failed read therefore announced itself as a change, the sheet
 * repainted, and it repainted again on recovery. Repeating the previous stamp says the honest thing
 * — nothing is known to have moved — and the failure goes to the log instead of to the workbook.
 */
let lastGoodOrganogramStamp: string | null = null;

function organogramStampFailure(cause: unknown): string {
  console.warn(
    lastGoodOrganogramStamp
      ? "[master map] the organogram stamp came back unusable; repeating the last good stamp so no repaint is triggered by the failure itself"
      : "[master map] the organogram stamp came back unusable and none is cached; the workbook will be treated as changed",
    cause,
  );
  return lastGoodOrganogramStamp ?? "organogram:unreadable";
}

async function stampOrganogram(): Promise<string> {
  try {
    const supabase = getSupabaseAdmin();
    const [areasResult, seatsResult] = await Promise.all([
      supabase
        .from("au_v_line_area_map")
        .select("area_code,line_code,operational_region_code,dm_seat_id,effective_from,effective_to")
        .limit(ORGANOGRAM_ROW_CAP),
      supabase
        .from("au_v_org_tree_sales")
        .select("seat_id,occupant_hr_id,is_other_pseudo_dm")
        .limit(ORGANOGRAM_ROW_CAP),
    ]);
    if (areasResult.error || seatsResult.error) {
      return organogramStampFailure(areasResult.error ?? seatsResult.error);
    }

    const areas = (areasResult.data ?? []) as Array<Record<string, unknown>>;
    const seats = (seatsResult.data ?? []) as Array<Record<string, unknown>>;

    // A full page is a truncated page. Hashing one would produce a stable stamp over partial data,
    // so the sheet would settle confidently on a workbook missing managers.
    if (areas.length >= ORGANOGRAM_ROW_CAP || seats.length >= ORGANOGRAM_ROW_CAP) {
      return organogramStampFailure(
        new Error(
          `the organogram came back at the ${ORGANOGRAM_ROW_CAP}-row ceiling (areas ${areas.length}, ` +
            `seats ${seats.length}) — treat it as truncated, not as the whole org`,
        ),
      );
    }

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
        ].join(FIELD_SEPARATOR),
      ),
      ...seats.map((row) =>
        [row.seat_id, row.occupant_hr_id, row.is_other_pseudo_dm].join(FIELD_SEPARATOR),
      ),
    ].sort();

    // A successful read that came back EMPTY is treated exactly like a failed one, because that is
    // the shape a broken view returns and the organogram is never legitimately empty. Same rule
    // loadOrganogram applies to the managers it hands the workbook, so the two stay in lockstep.
    if (areas.length === 0) return organogramStampFailure(new Error("the organogram returned no rows"));

    const stamp = `organogram:${areas.length}:${seats.length}:${foldToHash(parts)}`;
    lastGoodOrganogramStamp = stamp;
    return stamp;
  } catch (cause) {
    return organogramStampFailure(cause);
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
