import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isSeatEffectiveOn, normalizeRegionCode, type PlanningAreaSeat } from "@/lib/weekly-planning/regions";

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
 * Load the seat map in force for one line on `asOfDate` (Africa/Cairo today by default). Vacant
 * seats are included on purpose — an area with no rep is still a place a plan may name (the
 * Double Visit rep requirement is enforced separately, see areaHasAssignableRep).
 *
 * `effective_to is null` alone is NOT "currently effective": a row the organogram has accepted
 * but dated FORWARD is open-ended too. The Anti Infective Delta (3) split was written with
 * `effective_from = 2026-09-01` and immediately surfaced in the August picker — Ismailia,
 * Qalubeya, Sharkia 1, Sharkia 2 and Suez offered as plannable areas four days early — and
 * because `approvedRegionsForSeats` (regions.ts) derives the Region dropdown from these same
 * rows, the one missing predicate leaked the split into BOTH dropdowns at once.
 *
 * NOTE this pins the picker to TODAY, not to the week being planned: the workspace loads one
 * seat list and the client renders every selectable week from it. So a forward-dated area stays
 * unavailable until the day it takes effect, even on a plan covering a later week. Making it
 * period-aware means re-reading per week selection — a deliberately separate change.
 */
export async function loadPlanningAreaSeats(
  lineId: number | null | undefined,
  asOfDate: string = currentCairoDateOnlyIso(),
): Promise<PlanningAreaSeat[]> {
  if (typeof lineId !== "number") return [];
  const supabase = getSupabaseAdmin();

  const lineResult = await supabase.from("lines").select("code").eq("id", lineId).maybeSingle();
  if (lineResult.error) throw new Error(lineResult.error.message);
  const lineCode = lineResult.data?.code;
  if (!lineCode) return [];

  const [areaResult, regionResult] = await Promise.all([
    supabase
      .from("au_v_line_area_map")
      .select("area_name,operational_region_code,effective_from,effective_to")
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
    if (!isSeatEffectiveOn(row.effective_from, asOfDate)) continue;
    seats.push({ areaName, regionCode, regionName: regionNameByCode.get(regionCode) ?? null });
  }
  return seats;
}

/**
 * What the AU seat model knows about people, keyed by HR id.
 *
 * The employee roster's free-text `area_name` is blank for five currently-occupied areas
 * (Beni Suef, Fayoum, Dokki - Mohandseen - Bolak, Gharbia 1 (Tanta), Port said - Domiat), which
 * is why the Area picker was moved onto the seat model in the first place. The rep list still
 * reads that same blank column, so those areas were offered with no rep behind them. This gives
 * both lookups from one small read — the view is 97 rows.
 */
export type PlanningSeatDirectory = {
  /** HR id -> the area their AU rep seat covers. Fills the blank the employee row leaves. */
  areaByHrId: Map<string, string>;
  /** HR id -> the DM district the seat model states: seats they MANAGE first, else the seat they occupy. */
  districtByHrId: Map<string, string>;
};

type SeatDriftRow = {
  hr_id?: string | null;
  seat_tier?: string | null;
  seat_area_name?: string | null;
  seat_region_code?: string | null;
  seat_manager_hr_id?: string | null;
};

// MUST match the key service.ts builds with normalizeHrId — that lowercases AND strips the
// hyphen ("B-1" -> "b1"), so a plain trim/uppercase key here would never match anything.
const normalizeSeatHrId = (value: string | null | undefined) => normalizeHrIdForAccess(value) ?? "";

/** Collapse a multimap to the entries with exactly one distinct value — an ambiguous id stays unresolved. */
function onlyUnambiguous(values: Map<string, Set<string>>): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const [key, set] of values) {
    if (set.size === 1) resolved.set(key, [...set][0]);
  }
  return resolved;
}

export async function loadPlanningSeatDirectory(): Promise<PlanningSeatDirectory> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("au_v_employee_seat_drift")
    .select("hr_id,seat_tier,seat_area_name,seat_region_code,seat_manager_hr_id");
  if (error) throw new Error(error.message);

  const areaByHrId = new Map<string, string>();
  const managed = new Map<string, Set<string>>();
  const occupied = new Map<string, Set<string>>();

  for (const row of (data ?? []) as SeatDriftRow[]) {
    const hrId = normalizeSeatHrId(row.hr_id);
    const areaName = row.seat_area_name?.trim();
    const regionCode = normalizeRegionCode(row.seat_region_code);
    const managerHrId = normalizeSeatHrId(row.seat_manager_hr_id);

    if (hrId && areaName && row.seat_tier === "REP" && !areaByHrId.has(hrId)) {
      areaByHrId.set(hrId, areaName);
    }
    if (!regionCode) continue;
    // A manager's own REP seat (an acting DM still covering a territory) would otherwise make
    // them look like they occupy a district they merely sit inside; managed seats win below.
    if (managerHrId) {
      const set = managed.get(managerHrId) ?? new Set<string>();
      set.add(regionCode);
      managed.set(managerHrId, set);
    }
    if (hrId) {
      const set = occupied.get(hrId) ?? new Set<string>();
      set.add(regionCode);
      occupied.set(hrId, set);
    }
  }

  const districtByHrId = onlyUnambiguous(occupied);
  for (const [hrId, code] of onlyUnambiguous(managed)) districtByHrId.set(hrId, code);
  return { areaByHrId, districtByHrId };
}
