// ─────────────────────────────────────────────────────────────────────────────
// The sales seat tree, read for the two things an achievement row cannot say about itself.
//
// An AchievementRow (monthly-targets.ts) carries its rep seat and its DM seat and nothing higher,
// and when the DM seat was vacant at the period end its `dmHrId` is null. So the performance
// surfaces could neither NAME a vacant district — its reps all landed in one "Unassigned District"
// bucket — nor put a Regional Manager anywhere, because nothing on a row points above the DM seat.
// Owner, 2026-10-20: "when filter by manager u find no manager … every single role that's
// applicable to appear in a module, find and show it."
//
// This module answers both from `au_v_org_tree` (the public wrapper over au.seats, the same tree the
// organogram, Phoenix CRM and the seat-derived area scope read):
//
//   · vacantDistrictLabel — "Vacant — Alex-BHR" for a DM seat, from the seat's own district name.
//   · regionalManagerAbove — the occupied RSM seat directly above a DM seat, if there is one.
//
// It adds NO figure. Every roll-up built on it only regroups rows the Monthly Closing engine already
// priced and attributed; a vacant label renames a bucket that already existed.
//
// The tree is TODAY's wiring. Rows are attributed by seat occupancy as of each period end, so a past
// month's `dmHrId` is that month's DM; the RSM above it is the RSM seated now. One RSM seat existed
// when this was written (Pedia, read 2026-10-20), so the two readings only part if a seat changes
// hands.
// ─────────────────────────────────────────────────────────────────────────────

import { unstable_cache } from "next/cache";

import { getSupabaseAdmin } from "@/lib/supabase/server";

export type SalesSeat = {
  seatId: string;
  parentSeatId: string | null;
  /** CEO | NSM | RSM | DM | ACTING_DM | REP, as `au.v_org_tree` stores it. */
  tier: string;
  lineCode: string | null;
  /** For a DM / ACTING_DM seat, the district it runs ("Alex-BHR", "Delta (1)"). */
  regionName: string | null;
  /** As stored — the same spelling the achievement rows and the employee name map use. */
  occupantHrId: string | null;
  /** The per-line "Others" sales bucket. Holds nobody and is not a district. */
  isOtherPseudoDm: boolean;
};

export type SalesSeatTree = ReadonlyMap<string, SalesSeat>;

const DISTRICT_TIERS = new Set(["DM", "ACTING_DM"]);

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

/** Index raw `au_v_org_tree` rows by seat id. Pure. */
export function indexSalesSeats(rows: ReadonlyArray<Record<string, unknown>>): Map<string, SalesSeat> {
  const seats = new Map<string, SalesSeat>();
  for (const row of rows) {
    const seatId = text(row.seat_id);
    const tier = text(row.seat_tier);
    if (!seatId || !tier) continue;
    seats.set(seatId, {
      seatId,
      parentSeatId: text(row.parent_seat_id),
      tier,
      lineCode: text(row.line_code),
      regionName: text(row.region_name),
      occupantHrId: text(row.occupant_hr_id),
      isOtherPseudoDm: row.is_other_pseudo_dm === true,
    });
  }
  return seats;
}

/**
 * What a vacant district is called: "Vacant — <district>".
 *
 * Asked only of a row whose `dmHrId` is null — the engine already decided the seat had nobody in it
 * at that period end — so it does not test today's occupant. null for anything that is not a real
 * district seat (the "Others" bucket, an unknown seat), which keeps its old label.
 */
export function vacantDistrictLabel(dmSeatId: string | null | undefined, seats: SalesSeatTree): string | null {
  if (!dmSeatId) return null;
  const seat = seats.get(dmSeatId);
  if (!seat || seat.isOtherPseudoDm || !DISTRICT_TIERS.has(seat.tier)) return null;
  return `Vacant — ${seat.regionName ?? "district"}`;
}

/**
 * The Regional Manager over a district: the parent of the DM seat, when that parent is an OCCUPIED
 * RSM seat. A district that reports straight to its National Sales Manager has none, and a vacant
 * RSM seat names nobody — its districts stay under their own DM rows only.
 */
export function regionalManagerAbove(
  dmSeatId: string | null | undefined,
  seats: SalesSeatTree,
): { seatId: string; hrId: string } | null {
  if (!dmSeatId) return null;
  const seat = seats.get(dmSeatId);
  if (!seat || !DISTRICT_TIERS.has(seat.tier) || !seat.parentSeatId) return null;
  const parent = seats.get(seat.parentSeatId);
  if (!parent || parent.tier !== "RSM" || !parent.occupantHrId) return null;
  return { seatId: parent.seatId, hrId: parent.occupantHrId };
}

/**
 * The seat rows, cached five minutes under `sos-reference` — the tag every seat-moving write already
 * busts (see invalidateExecutiveDashboardCache), shared with the Phoenix CRM and CRM placement reads
 * of the same view. The ROWS are cached, never the Map: unstable_cache serialises what it stores.
 */
const loadSalesSeatRows = unstable_cache(
  async (): Promise<Array<Record<string, unknown>>> => {
    const { data, error } = await getSupabaseAdmin()
      .from("au_v_org_tree")
      .select("seat_id,parent_seat_id,seat_tier,line_code,region_name,occupant_hr_id,is_other_pseudo_dm");
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    // An unbounded PostgREST read stops at 1,000 rows with no error; never resolve half a tree.
    if (rows.length >= 1000) {
      throw new Error(`au_v_org_tree returned ${rows.length} rows, at PostgREST's cap. Paginate this read before trusting it.`);
    }
    return rows;
  },
  ["sales-seat-hierarchy-v1"],
  { revalidate: 300, tags: ["sos-reference"] },
);

/**
 * The seat tree, best effort. A failed read yields an EMPTY tree, which only means no vacant label
 * and no Regional Manager row — every figure on the page is unchanged, because none comes from here.
 */
export async function loadSalesSeatTree(): Promise<Map<string, SalesSeat>> {
  try {
    return indexSalesSeats(await loadSalesSeatRows());
  } catch {
    return new Map();
  }
}
