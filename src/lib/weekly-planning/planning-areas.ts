import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeRegionCode, type PlanningAreaSeat } from "@/lib/weekly-planning/regions";

export type { PlanningAreaSeat };

/**
 * Which areas a Medical Rep may plan against.
 *
 * The authority is the AU seat model (`au_v_line_area_map` + `au_v_regions`), NOT the employee
 * roster. The roster gets this wrong twice over:
 *
 *   - it misses areas whose occupant has a blank `area_name` on their employee row. Beni Suef
 *     is exactly that case for Anti Infective, so it never appeared as an option even though
 *     the seat model has carried it all along.
 *   - it cannot express the DM territory split. Anti Infective divides Upper Egypt into UE-1
 *     (Minia 1, Minia 2, Beni Suef) and UE-2 (Assuit, Sohag, Qena); CNS and Pedia keep one
 *     undivided UE. A rep belongs to one district and plans inside it.
 */

/**
 * Load the currently-effective seat map for one line. Vacant seats are included on purpose —
 * an area with no rep is still a place a plan may name (the Double Visit rep requirement is
 * enforced separately, see areaHasAssignableRep).
 */
export async function loadPlanningAreaSeats(lineId: number | null | undefined): Promise<PlanningAreaSeat[]> {
  if (typeof lineId !== "number") return [];
  const supabase = getSupabaseAdmin();

  const lineResult = await supabase.from("lines").select("code").eq("id", lineId).maybeSingle();
  if (lineResult.error) throw new Error(lineResult.error.message);
  const lineCode = lineResult.data?.code;
  if (!lineCode) return [];

  const [areaResult, regionResult] = await Promise.all([
    supabase
      .from("au_v_line_area_map")
      .select("area_name,operational_region_code,effective_to")
      .eq("line_code", lineCode)
      .is("effective_to", null),
    supabase.from("au_v_regions").select("region_code,region_name"),
  ]);
  if (areaResult.error) throw new Error(areaResult.error.message);
  if (regionResult.error) throw new Error(regionResult.error.message);

  const regionNameByCode = new Map<string, string>();
  for (const row of regionResult.data ?? []) {
    const code = normalizeRegionCode(row.region_code);
    const name = row.region_name?.trim();
    if (code && name) regionNameByCode.set(code, name);
  }

  const seats: PlanningAreaSeat[] = [];
  for (const row of areaResult.data ?? []) {
    const areaName = row.area_name?.trim();
    const regionCode = normalizeRegionCode(row.operational_region_code);
    if (!areaName || !regionCode) continue;
    seats.push({ areaName, regionCode, regionName: regionNameByCode.get(regionCode) ?? null });
  }
  return seats;
}
