import { normalizeLineName } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import {
  buildHeadOfficeOrganogramRows,
  HEAD_OFFICE_LINE_ID,
} from "@/lib/reports/organogram-head-office";
import { hasWhatsAppNumber } from "@/lib/reports/organogram-whatsapp";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  OrganogramReportRow,
  OrganogramWorkFields,
  VacancyReportData,
} from "@/lib/reports/vacancies";

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

/**
 * The employee-master columns joined onto each occupied seat. Work fields only.
 *
 * The last three (`line_id`, `manager_hr_id`, `organogram_visible`) are NOT used by the seat
 * path — they feed `buildHeadOfficeOrganogramRows`, which assembles the Head Office branch
 * the AU seat model has no seats for. They ride on this select rather than a second query
 * because every round trip crosses to Frankfurt; see organogram-head-office.ts.
 */
type EmployeeWorkRow = {
  contract_renewal_date: string | null;
  contract_type: string | null;
  department_name: string | null;
  employment_status: string | null;
  full_name: string | null;
  hire_date: string | null;
  hr_id: string | null;
  job_title: string | null;
  line_id: number | null;
  manager_hr_id: string | null;
  /** Read ONLY to compute the hasWhatsApp boolean below — never placed on a row. */
  mobile_number: string | null;
  name_ar: string | null;
  organogram_visible: boolean | null;
  team_name: string | null;
  work_email: string | null;
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

  // Resolve occupant display names, hire dates and the WORK-ONLY employee fields from
  // the employee master (best-effort). The seat model itself carries no tenure or
  // contact data, so it is joined here — widening this ONE existing select rather than
  // adding a second query, because every round trip crosses to Frankfurt.
  //
  // The column list is the safe set defined on OrganogramWorkFields: nothing personal
  // (no national ID, birth date, gender, address) and nothing from payroll. Read that
  // type's note before adding a column here.
  //
  // mobile_number is the ONE exception and it never leaves this function: it is reduced
  // immediately to the hasWhatsApp boolean, so the chart learns whether a person is
  // reachable and never what their number is. The number is resolved per press by
  // /api/reports/organogram/whatsapp/[hrId] instead.
  const { data: empData } = await supabase
    .from("employees")
    .select(
      "hr_id, full_name, name_ar, work_email, mobile_number, job_title, employment_status, contract_type, contract_renewal_date, hire_date, department_name, team_name, line_id, manager_hr_id, organogram_visible",
    );
  const nameByHr = new Map<string, string>();
  const hireDateByHr = new Map<string, string>();
  const workByHr = new Map<string, EmployeeWorkRow>();
  for (const e of (empData ?? []) as EmployeeWorkRow[]) {
    if (!e.hr_id) continue;
    const key = e.hr_id.trim().toLowerCase();
    nameByHr.set(key, e.full_name ?? e.hr_id);
    if (e.hire_date) hireDateByHr.set(key, e.hire_date);
    workByHr.set(key, e);
  }
  // Vacant seats have no employee to read from, so every field stays null and the
  // export renders an empty cell rather than inventing a placeholder.
  const workFieldsFor = (hrId: string | null): OrganogramWorkFields => {
    const employee = hrId ? workByHr.get(hrId.trim().toLowerCase()) : undefined;
    if (!employee) {
      return {
        contractRenewalDate: null,
        contractType: null,
        employeeDepartmentName: null,
        employeeJobTitle: null,
        employeeTeamName: null,
        employmentStatus: null,
        hasWhatsApp: false,
        nameAr: null,
        workEmail: null,
      };
    }
    return {
      contractRenewalDate: employee.contract_renewal_date,
      contractType: employee.contract_type,
      employeeDepartmentName: employee.department_name,
      employeeJobTitle: employee.job_title,
      employeeTeamName: employee.team_name,
      employmentStatus: employee.employment_status,
      hasWhatsApp: hasWhatsAppNumber(employee.mobile_number),
      nameAr: employee.name_ar,
      workEmail: employee.work_email,
    };
  };
  const displayNameFor = (hrId: string | null): string => {
    if (!hrId) return "Vacant";
    return nameByHr.get(hrId.trim().toLowerCase()) ?? hrId;
  };
  // Null for vacant seats and HR_IDs with no recorded hire date.
  const hireDateFor = (hrId: string | null): string | null => {
    if (!hrId) return null;
    return hireDateByHr.get(hrId.trim().toLowerCase()) ?? null;
  };

  const nodeKeyBySeat = new Map<string, string>();
  const occupantBySeat = new Map<string, string | null>();
  for (const s of tree) {
    nodeKeyBySeat.set(s.seat_id, nodeKeyOf(s));
    occupantBySeat.set(s.seat_id, s.occupant_hr_id && s.occupant_hr_id.trim() ? s.occupant_hr_id.trim() : null);
  }

  // Acting-DM occupants (their own REP seat is collapsed into the ACTING_DM node).
  // Keyed by occupant ALONE — never by line_code. Gating the collapse on a matching
  // line_code would let the same person be emitted twice (once as the ACTING_DM node,
  // once as an un-collapsed REP seat) whenever the ACTING_DM seat's line_code is null
  // or differs from the REP seat's — two rows sharing one nodeKey (the HR_ID), i.e. a
  // duplicate node and a self-referential manager lookup. An occupant who holds any
  // ACTING_DM seat is always rendered from it, so their REP seat is always collapsed.
  const actingOccupants = new Set<string>();
  for (const s of tree) {
    if (s.seat_tier === "ACTING_DM" && s.occupant_hr_id && s.occupant_hr_id.trim()) {
      actingOccupants.add(s.occupant_hr_id.trim().toLowerCase());
    }
  }

  // A seat is DROPPED from the emitted tree when it is the per-line "Others" pseudo-DM
  // (holds no people) or the acting DM's own REP seat (collapsed into the ACTING_DM
  // node). Centralised so manager resolution can climb past a dropped seat.
  const isDropped = (s: AuTreeRow): boolean => {
    if (s.is_other_pseudo_dm) return true; // "Others" holds no people
    if (
      s.seat_tier === "REP" &&
      s.occupant_hr_id &&
      actingOccupants.has(s.occupant_hr_id.trim().toLowerCase())
    ) {
      return true; // acting DM's own area — represented by the ACTING_DM node
    }
    return false;
  };

  const seatById = new Map<string, AuTreeRow>();
  for (const s of tree) seatById.set(s.seat_id, s);

  // Nearest ANCESTOR seat that is actually emitted, climbing parent_seat_id and
  // skipping any dropped seat. Without this, a child whose immediate parent seat was
  // dropped (an "Others" pseudo-DM, or a collapsed acting-DM REP seat) would carry a
  // managerHrId pointing at a node that was never emitted — orphaning it in the
  // client's tree-climb. Re-homing to the closest real manager above keeps it placed.
  // The `seen` guard makes a malformed cyclic parent chain terminate instead of hang.
  const nearestEmittedParentSeat = (s: AuTreeRow): AuTreeRow | null => {
    const seen = new Set<string>([s.seat_id]);
    let parentId = s.parent_seat_id;
    while (parentId && !seen.has(parentId)) {
      const parent = seatById.get(parentId);
      if (!parent) break;
      if (!isDropped(parent)) return parent;
      seen.add(parentId);
      parentId = parent.parent_seat_id;
    }
    return null;
  };

  const rows: OrganogramReportRow[] = [];
  for (const s of tree) {
    if (isDropped(s)) continue;

    const nodeKey = nodeKeyBySeat.get(s.seat_id)!;
    const managerSeat = nearestEmittedParentSeat(s);
    const managerHrId = managerSeat ? (nodeKeyBySeat.get(managerSeat.seat_id) ?? null) : null;
    // Manager display name = the parent seat's occupant name (never an HR_ID/seat code). Left null
    // when the manager seat is vacant, so the vacant-seat labeller (area/team/line name) takes over.
    const managerOccupant = managerSeat ? (occupantBySeat.get(managerSeat.seat_id) ?? null) : null;
    const managerName = managerOccupant ? displayNameFor(managerOccupant) : null;
    const occupied = Boolean(s.occupant_hr_id && s.occupant_hr_id.trim());

    rows.push({
      ...workFieldsFor(s.occupant_hr_id),
      areaId: null,
      areaName: s.area_name,
      departmentId: null,
      // Stays null, as it always has. The employee master's department reaches the
      // export through `employeeDepartmentName` instead — see OrganogramWorkFields.
      departmentName: null,
      displayName: displayNameFor(s.occupant_hr_id),
      fullName: displayNameFor(s.occupant_hr_id),
      hireDate: hireDateFor(s.occupant_hr_id),
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

  // The Head Office branch. The AU seat model covers the sales force only — it has no
  // Head Office seats at all — so those employees are assembled from the employee master
  // and hung off the CEO node. Appended here, at the single source every organogram and
  // vacancy-tree caller reads, so the existing boundaries apply to it untouched:
  // `scopeAuOrganogramRows` drops the branch in line mode (its rows name a line), and
  // `getOrganogramReport` strips it in company mode for anyone without
  // `canAccessHeadOffice`. See organogram-head-office.ts.
  const ceoSeat = tree.find((s) => s.seat_tier === "CEO" && !isDropped(s));
  const occupiedHrIds = new Set<string>();
  for (const s of tree) {
    const key = canonicalHrIdKey(s.occupant_hr_id);
    if (key) occupiedHrIds.add(key);
  }
  // Open HEAD OFFICE seats, so the chart shows a department's unfilled roles the way it
  // already shows an unfilled sales seat. Filtered in SQL to line 4 + open — a sales vacancy
  // arrives from its own unfilled `au.seats` row and must not be drawn a second time from
  // here. Five columns only: a vacancy row also carries a `note` naming the person who
  // resigned and a public `vacancy_code`, and neither belongs on a chart node.
  //
  // This is a second round trip to Frankfurt, which the select above goes out of its way to
  // avoid. It is accepted rather than folded in because there is nothing to fold it into:
  // `position_vacancies` is a different table, the filter returns a handful of rows, and the
  // alternative is a department that renders as a manager with nobody under him. A failure
  // here degrades to "no open seats drawn" rather than taking the whole chart down with it.
  const { data: vacancyData, error: vacancyError } = await supabase
    .from("position_vacancies")
    .select("id, job_title, line_id, manager_hr_id, status")
    .eq("line_id", HEAD_OFFICE_LINE_ID)
    .eq("status", "open");
  if (vacancyError) {
    console.warn(
      `organogram: open Head Office seats could not be read (${vacancyError.message}); the chart is drawn without them`,
    );
  }

  const headOfficeRows = buildHeadOfficeOrganogramRows((empData ?? []) as EmployeeWorkRow[], {
    ceoNodeKey: ceoSeat ? (nodeKeyBySeat.get(ceoSeat.seat_id) ?? null) : null,
    occupiedHrIds,
    vacancies: vacancyData ?? [],
  });

  return { organogramRows: [...rows, ...headOfficeRows], rows: [], summary: { ...emptySummary } };
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
