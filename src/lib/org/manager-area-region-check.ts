// Loads what `detectManagerAreaDrift` decides on, and nothing else.
//
// Split from the pure module so the rule itself stays testable without a database, and so the one
// thing that talks to PostgREST here carries its own paging. `public.areas` is already past a
// thousand rows (the Upper Egypt split pushed it to 1150 on 2026-09-11) and an unbounded
// `.select()` silently stops at 1000 with no marker — which here would drop the newest region rows
// and report exactly the false alarm this check exists to raise.
//
// Teams are resolved from the team list rather than through a PostgREST embed. The check needs the
// AREA a team hangs off, not only its name, so it has to hold the whole team list anyway — and one
// list beats an embed whose shape changes with the foreign key.

import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  type AreaRow,
  type ManagerAreaFinding,
  type ManagerRow,
  type TeamRow,
  detectManagerAreaDrift,
  isRegionOwningTitle,
} from "./manager-area-region";

/** PostgREST caps a select at 1000 rows; page below that so the boundary is never the limit. */
const PAGE_SIZE = 500;

async function loadPaged<T>(
  table: string,
  columns: string,
  orderBy: string,
  map: (row: Record<string, unknown>) => T | null,
): Promise<T[]> {
  const supabase = getSupabaseAdmin();
  const out: T[] = [];
  for (let page = 0; ; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    // Through `unknown` on purpose: the column list is a runtime string, so the client cannot infer
    // a row shape and types the payload as GenericStringError[]. A direct cast is rejected.
    const rows = ((data ?? []) as unknown) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const mapped = map(row);
      if (mapped !== null) out.push(mapped);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * Every manager recorded against a rep area or a rep-area team, and every region missing the area
 * or team row a manager needs to point at.
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
    // A failed seat read throws like the others, so the run reports "did not run" — never "nobody
    // holds a rep seat", which would bring the acting district manager's false alarm back.
    const [areas, teams, managerRows, repSeatHolderIds] = await Promise.all([
      loadPaged<AreaRow>("areas", "id,name", "id", (row) => {
        const areaId = numberOrNull(row.id);
        const areaName = textOrNull(row.name);
        return areaId !== null && areaName !== null ? { areaId, areaName } : null;
      }),
      loadPaged<TeamRow>("teams", "id,name,area_id", "id", (row) => {
        const teamId = numberOrNull(row.id);
        const teamName = textOrNull(row.name);
        return teamId !== null && teamName !== null
          ? { teamId, teamName, areaId: numberOrNull(row.area_id) }
          : null;
      }),
      loadPaged<Record<string, unknown>>(
        "employees",
        "hr_id,full_name,job_title,region_name,area_id,team_id,employment_status",
        "hr_id",
        (row) => (String(row.employment_status ?? "").toLowerCase() === "active" ? row : null),
      ),
      loadPaged<string>("au_v_employee_seat_drift", "hr_id,seat_tier", "seat_id", (row) =>
        String(row.seat_tier ?? "").toUpperCase() === "REP" ? textOrNull(row.hr_id) : null),
    ]);
    const repSeatHolders = new Set(repSeatHolderIds);

    const areaNameById = new Map(areas.map((area) => [area.areaId, area.areaName]));
    const teamById = new Map(teams.map((team) => [team.teamId, team]));

    const managers: ManagerRow[] = managerRows
      .filter((row) => isRegionOwningTitle(String(row.job_title ?? "")))
      .map((row) => {
        const areaId = numberOrNull(row.area_id);
        const teamId = numberOrNull(row.team_id);
        const team = teamId === null ? undefined : teamById.get(teamId);
        const teamAreaId = team?.areaId ?? null;
        return {
          hrId: String(row.hr_id ?? ""),
          fullName: textOrNull(row.full_name),
          jobTitle: textOrNull(row.job_title),
          regionName: textOrNull(row.region_name),
          areaId,
          areaName: areaId === null ? null : areaNameById.get(areaId) ?? null,
          teamId,
          teamName: team?.teamName ?? null,
          teamAreaId,
          teamAreaName: teamAreaId === null ? null : areaNameById.get(teamAreaId) ?? null,
        } satisfies ManagerRow;
      })
      .filter((row) => row.hrId.length > 0);

    return { ran: true, findings: detectManagerAreaDrift(managers, areas, teams, repSeatHolders) };
  } catch (error) {
    logError("Could not check whether every sales manager is recorded against their region", {
      error,
      labels: { event: "manager_area_region_check_failed", job: "territory-restamp" },
    });
    return { ran: false, findings: [] };
  }
}
