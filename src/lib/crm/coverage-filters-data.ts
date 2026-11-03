/**
 * The one database read behind the Region → Line → Area → Rep cascade.
 *
 * Kept apart from `coverage-filters.ts` deliberately: that module is pure so the filter bar can run
 * the narrowing in the browser, and it stops being pure the moment a Supabase import lands in it.
 * Everything server-only belongs here.
 */

import { unstable_cache } from "next/cache";

import { buildCoverageFilterTree, type CoverageFilterTree } from "@/lib/crm/coverage-filters";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const clean = (value: string | null | undefined): string => (value ?? "").trim();

const namesFrom = (rows: Array<Record<string, string | null>>, codeKey: string, nameKey: string) => {
  const out = new Map<string, string>();
  for (const row of rows) {
    const code = clean(row[codeKey]);
    if (code) out.set(code, clean(row[nameKey]) || code);
  }
  return out;
};

/**
 * The two views the territory loaders already read, plus region and line names.
 *
 * Names come from `au_v_regions` and `public.lines` rather than being title-cased from the code:
 * the owner's standing rule is human-readable names everywhere, and a code like `cns` humanizes to
 * "Cns", not "CNS". Only the table knows the difference.
 *
 * No pagination: measured 2026-08-21 these are 107, 96, 9 and 4 rows against PostgREST's 1,000-row
 * cap. Cached 5 minutes under the `sos-reference` tag alongside the other geography reads — the org
 * chart does not move during a session and both boards call this on every render.
 */
export const loadCoverageFilterTree = unstable_cache(
  async (): Promise<CoverageFilterTree> => {
    const supabase = getSupabaseAdmin();
    const [mapRes, seatsRes, regionRes, lineRes] = await Promise.all([
      supabase
        .from("au_v_line_area_map")
        .select("operational_region_code, line_code, area_code, area_name, rep_seat_id, carries_target, effective_to")
        .is("effective_to", null)
        .eq("carries_target", true),
      supabase.from("au_v_employee_seat_drift").select("hr_id, full_name, seat_id, seat_tier"),
      supabase.from("au_v_regions").select("region_code, region_name"),
      supabase.from("lines").select("code, name"),
    ]);
    if (mapRes.error) throw new Error(mapRes.error.message);
    if (seatsRes.error) throw new Error(seatsRes.error.message);
    if (regionRes.error) throw new Error(regionRes.error.message);
    if (lineRes.error) throw new Error(lineRes.error.message);

    const seatRows = (seatsRes.data ?? []) as Array<Record<string, string | null>>;
    // The view carries `full_name` only: a rep is printed by his display name, read by HR id, and a
    // failed name read keeps the view's name.
    const repNames = await namesByHrId(seatRows.map((row) => row.hr_id)).catch(() => null);

    return buildCoverageFilterTree({
      lineNames: namesFrom((lineRes.data ?? []) as Array<Record<string, string | null>>, "code", "name"),
      mapRows: ((mapRes.data ?? []) as Array<Record<string, string | null>>).map((row) => ({
        areaCode: row.area_code,
        areaName: row.area_name,
        lineCode: row.line_code,
        regionCode: row.operational_region_code,
        repSeatId: row.rep_seat_id,
      })),
      regionNames: namesFrom((regionRes.data ?? []) as Array<Record<string, string | null>>, "region_code", "region_name"),
      seats: seatRows.map((row) => ({
        fullName: repNames?.get(row.hr_id) ?? row.full_name,
        hrId: row.hr_id,
        seatId: row.seat_id,
        seatTier: row.seat_tier,
      })),
    });
  },
  ["crm-coverage-filter-tree"],
  { revalidate: 300, tags: ["sos-reference"] },
);
