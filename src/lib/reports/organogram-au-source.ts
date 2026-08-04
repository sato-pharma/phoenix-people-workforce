import { normalizeLineName } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { OrganogramReportRow, VacancyReportData } from "@/lib/reports/vacancies";

/**
 * Area-unification organogram source.
 *
 * Builds the flat `organogramRows` the existing organogram UI consumes, but
 * sourced from the NEW seat model (schema `au`, via the public.au_v_org_tree
 * wrapper) instead of the manager_hr_id + job-title heuristics. The tree is
 * still assembled client-side by climbing `managerHrId`; we emit clean,
 * authoritative rows so the rescue heuristics stay dormant.
 *
 * Key mappings:
 *  - nodeKey = occupant HR_ID when filled, else the stable seat_id (so vacant
 *    seats — vacant DMs included — still anchor their reports' managerHrId).
 *  - positionTitle is derived from seat_tier so the existing classifier keys
 *    the right level (NSM/RSM/DM/rep) with no title guessing.
 *  - the acting-DM (a rep who also manages areas) is emitted once, from its
 *    ACTING_DM seat, so it renders as a DM lane; its own REP seat is skipped to
 *    avoid a self-manager cycle.
 *  - the per-line "Others" pseudo-DM has no people and is not emitted.
 */

type AuTreeRow = {
  seat_id: string;
  parent_seat_id: string | null;
  seat_tier: "CEO" | "NSM" | "RSM" | "DM" | "ACTING_DM" | "REP";
  line_code: string | null;
  region_code: string | null;
  area_code: string | null;
  is_other_pseudo_dm: boolean;
  occupant_hr_id: string | null;
  is_vacant: boolean;
  area_name: string | null;
  region_name: string | null;
  line_name: string | null;
  line_id: number | null;
};

const TITLE_BY_TIER: Record<AuTreeRow["seat_tier"], string> = {
  CEO: "CEO",
  NSM: "National Sales Manager",
  RSM: "Regional Sales Manager",
  DM: "District Sales Manager",
  ACTING_DM: "District Sales Manager",
  REP: "Medical Representative",
};

const emptySummary = {
  areasAffected: 0,
  linesAffected: 0,
  openVacancies: 0,
  positionsAffected: 0,
  totalVacancies: 0,
};

function nodeKeyOf(row: Pick<AuTreeRow, "occupant_hr_id" | "seat_id">): string {
  return row.occupant_hr_id && row.occupant_hr_id.trim() ? row.occupant_hr_id.trim() : row.seat_id;
}

/** Reads the seat model and returns a full organogram report (all lines). */
export async function buildOrganogramSeatReport(): Promise<VacancyReportData> {
  const supabase = getSupabaseAdmin();

  const { data: treeData, error } = await supabase
    .from("au_v_org_tree")
    .select(
      "seat_id,parent_seat_id,seat_tier,line_code,region_code,area_code,is_other_pseudo_dm,occupant_hr_id,is_vacant,area_name,region_name,line_name,line_id",
    );
  if (error) throw new Error(`organogram seat source failed: ${error.message}`);
  const tree = (treeData ?? []) as AuTreeRow[];

  // Resolve occupant display names from the employee master (best-effort).
  const { data: empData } = await supabase.from("employees").select("hr_id, full_name");
  const nameByHr = new Map<string, string>();
  for (const e of (empData ?? []) as Array<{ hr_id: string | null; full_name: string | null }>) {
    if (e.hr_id) nameByHr.set(e.hr_id.trim().toLowerCase(), e.full_name ?? e.hr_id);
  }
  const displayNameFor = (hrId: string | null): string => {
    if (!hrId) return "Vacant";
    return nameByHr.get(hrId.trim().toLowerCase()) ?? hrId;
  };

  const nodeKeyBySeat = new Map<string, string>();
  const occupantBySeat = new Map<string, string | null>();
  for (const s of tree) {
    nodeKeyBySeat.set(s.seat_id, nodeKeyOf(s));
    occupantBySeat.set(s.seat_id, s.occupant_hr_id && s.occupant_hr_id.trim() ? s.occupant_hr_id.trim() : null);
  }

  // Acting-DM occupants per line (their own REP seat is collapsed into the ACTING_DM node).
  const actingByLine = new Map<string, Set<string>>();
  for (const s of tree) {
    if (s.seat_tier === "ACTING_DM" && s.occupant_hr_id && s.line_code) {
      const set = actingByLine.get(s.line_code) ?? new Set<string>();
      set.add(s.occupant_hr_id.trim().toLowerCase());
      actingByLine.set(s.line_code, set);
    }
  }

  const rows: OrganogramReportRow[] = [];
  for (const s of tree) {
    if (s.is_other_pseudo_dm) continue; // "Others" holds no people
    if (
      s.seat_tier === "REP" &&
      s.occupant_hr_id &&
      s.line_code &&
      actingByLine.get(s.line_code)?.has(s.occupant_hr_id.trim().toLowerCase())
    ) {
      continue; // acting DM's own area — represented by the ACTING_DM node
    }

    const nodeKey = nodeKeyBySeat.get(s.seat_id)!;
    const managerHrId = s.parent_seat_id ? (nodeKeyBySeat.get(s.parent_seat_id) ?? null) : null;
    // Manager display name = the parent seat's occupant name (never an HR_ID/seat code). Left null
    // when the manager seat is vacant, so the vacant-seat labeller (area/team/line name) takes over.
    const managerOccupant = s.parent_seat_id ? (occupantBySeat.get(s.parent_seat_id) ?? null) : null;
    const managerName = managerOccupant ? displayNameFor(managerOccupant) : null;
    const occupied = Boolean(s.occupant_hr_id && s.occupant_hr_id.trim());

    rows.push({
      areaId: null,
      areaName: s.area_name,
      departmentId: null,
      departmentName: null,
      displayName: displayNameFor(s.occupant_hr_id),
      fullName: displayNameFor(s.occupant_hr_id),
      hireDate: null,
      hrId: nodeKey,
      jobTitle: TITLE_BY_TIER[s.seat_tier],
      lineId: s.line_id,
      lineName: s.line_name,
      managerHrId,
      managerReplacementForHrId: null,
      managerName,
      positionId: null,
      positionTitle: TITLE_BY_TIER[s.seat_tier],
      regionName: s.region_name,
      replacementForHrId: null,
      seatId: s.seat_id,
      sourceRowNumber: null,
      status: occupied ? "active" : "open",
      teamId: null,
      teamName: null,
      type: occupied ? "employee" : "vacancy",
      vacancyCode: null,
    });
  }

  return { organogramRows: rows, rows: [], summary: { ...emptySummary } };
}

/** Scope the seat rows to the viewer's line(s); CEO (line-less) is always kept. */
export function scopeAuOrganogramRows(
  rows: OrganogramReportRow[],
  options: { mode: "company" | "line"; lineName?: string | null; lineNames?: string[] | null },
): OrganogramReportRow[] {
  if (options.mode === "company") return rows;
  const allowed = new Set(
    (options.lineNames && options.lineNames.length > 0 ? options.lineNames : [options.lineName])
      .filter((l): l is string => Boolean(l))
      .map((l) => normalizeLineName(l)),
  );
  return rows.filter((row) => {
    if (!row.lineName) return true; // CEO / line-less leadership
    return allowed.has(normalizeLineName(row.lineName));
  });
}
