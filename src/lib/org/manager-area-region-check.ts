// Loads what `detectManagerAreaDrift` decides on, and nothing else.
//
// Split from the pure module so the rule itself stays testable without a database, and so the one
// thing that talks to PostgREST here carries its own paging. `public.areas` is already past a
// thousand rows (the Upper Egypt split pushed it to 1150 on 2026-09-11) and an unbounded
// `.select()` silently stops at 1000 with no marker — which here would drop the newest region rows
// and report exactly the false alarm this check exists to raise.

import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  type AreaRow,
  type ManagerAreaFinding,
  type ManagerRow,
  detectManagerAreaDrift,
  isRegionOwningTitle,
} from "./manager-area-region";

/** PostgREST caps a select at 1000 rows; page below that so the boundary is never the limit. */
const PAGE_SIZE = 500;

async function loadAllAreas(): Promise<AreaRow[]> {
  const supabase = getSupabaseAdmin();
  const areas: AreaRow[] = [];
  for (let page = 0; ; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from("areas")
      .select("id,name")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: unknown; name: unknown }>;
    for (const row of rows) {
      const areaId = Number(row.id);
      const areaName = String(row.name ?? "").trim();
      if (Number.isFinite(areaId) && areaName) areas.push({ areaId, areaName });
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return areas;
}

async function loadRegionOwningManagers(): Promise<ManagerRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,full_name,job_title,region_name,area_id,areas(name)")
    .eq("employment_status", "active")
    .order("hr_id", { ascending: true })
    .range(0, PAGE_SIZE - 1);
  if (error) throw error;

  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => isRegionOwningTitle(String(row.job_title ?? "")))
    .map((row) => {
      const joined = row.areas as { name?: unknown } | Array<{ name?: unknown }> | null;
      const areaName = Array.isArray(joined)
        ? String(joined[0]?.name ?? "").trim() || null
        : String(joined?.name ?? "").trim() || null;
      const areaId = row.area_id === null || row.area_id === undefined ? null : Number(row.area_id);
      return {
        hrId: String(row.hr_id ?? ""),
        fullName: String(row.full_name ?? "").trim() || null,
        jobTitle: String(row.job_title ?? "").trim() || null,
        regionName: String(row.region_name ?? "").trim() || null,
        areaId: areaId !== null && Number.isFinite(areaId) ? areaId : null,
        areaName,
      } satisfies ManagerRow;
    })
    .filter((row) => row.hrId.length > 0);
}

/**
 * Every manager recorded against a rep area, and every region with no area row to point at.
 *
 * NEVER THROWS. This runs inside the nightly territory re-stamp, whose actual work — keeping open
 * periods on today's geography — has nothing to do with manager geography. A read that fails here
 * must not fail the job, so the error is logged and the caller is told the check did not run,
 * which is deliberately different from "the check ran and found nothing".
 */
export async function findManagerAreaDrift(): Promise<{
  ran: boolean;
  findings: ManagerAreaFinding[];
}> {
  try {
    const [managers, areas] = await Promise.all([loadRegionOwningManagers(), loadAllAreas()]);
    return { ran: true, findings: detectManagerAreaDrift(managers, areas) };
  } catch (error) {
    logError("Could not check whether every sales manager is recorded against his region", {
      error,
      labels: { event: "manager_area_region_check_failed", job: "territory-restamp" },
    });
    return { ran: false, findings: [] };
  }
}
