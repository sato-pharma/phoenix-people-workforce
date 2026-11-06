/**
 * Phoenix CRM — the organogram read behind every scope decision.
 *
 * The same read as src/lib/crm/org-placement-data.ts: au_v_org_tree, the whole tree, cached five
 * minutes under `sos-reference`. What is cached is the ROWS, never the index: `unstable_cache`
 * serializes what it stores and a Map comes back `{}` (that module's note records the crash it
 * caused). The index is rebuilt from the rows on every call — one pass over ~140 seats.
 */

import { unstable_cache } from "next/cache";

import { buildOrgIndex, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

const loadOrgSeats = unstable_cache(
  async (): Promise<OrgSeat[]> => {
    // Paged to the last row, never half a tree: a handover seat is two rows, so (seat, occupant) closes the order.
    const rows = await fetchAllRows<Record<string, unknown>>(
      () =>
        getSupabaseAdmin()
          .from("au_v_org_tree")
          .select(
            "seat_id, parent_seat_id, seat_tier, path, occupant_hr_id, line_code, line_name, area_code, area_name, region_code, region_name, seat_label, is_other_pseudo_dm",
          )
          .order("seat_id", { ascending: true }),
      "occupant_hr_id",
    ).catch((error: unknown) => {
      throw toQueryError(error);
    });
    return rows.flatMap((row) => {
      const seatId = text(row.seat_id);
      const tier = text(row.seat_tier);
      if (!seatId || !tier) return [];
      const path = (Array.isArray(row.path) ? row.path : []).map((entry) => text(entry)).filter((entry): entry is string => entry !== null);
      return [
        {
          seatId,
          parentSeatId: text(row.parent_seat_id),
          tier,
          path: path.length > 0 ? path : [seatId],
          occupantHrId: text(row.occupant_hr_id),
          lineCode: text(row.line_code),
          lineName: text(row.line_name),
          areaCode: text(row.area_code),
          areaName: text(row.area_name),
          regionCode: text(row.region_code),
          regionName: text(row.region_name),
          seatLabel: text(row.seat_label),
          isOtherPseudoDm: row.is_other_pseudo_dm === true,
        },
      ];
    });
  },
  // v4: the rows gained `region_code` (the Training Manager's weekly plan, 2026-10-24) on top of v3's
  // `is_other_pseudo_dm` (the team-readiness board, 2026-10-03) and v2's `area_code` (the daily
  // forecast, 2026-10-01). A new key each time, so a cached copy of the old shape — without the
  // column — is never served to a reader that needs it.
  ["phoenix-crm-org-seats-v4"],
  { revalidate: 300, tags: ["sos-reference"] },
);

export async function loadPhoenixCrmOrg(): Promise<OrgIndex> {
  return buildOrgIndex(await loadOrgSeats());
}
