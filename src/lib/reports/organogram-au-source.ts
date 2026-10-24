import { normalizeLineName } from "@/lib/auth/permissions";
import { loadOfferOutBySeat } from "@/lib/offers/seat-offers";
import { resolveEmployeeDepartmentName } from "@/lib/employees/employee-org-labels";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { ORG_SEAT_TITLE, type OrgSeatTier } from "@/lib/org/seat-titles";
import {
  buildHeadOfficeOrganogramRows,
  HEAD_OFFICE_LINE_ID,
} from "@/lib/reports/organogram-head-office";
import { organogramAsOfMonthEnd } from "@/lib/reports/organogram-as-of";
import { hasWhatsAppNumber } from "@/lib/reports/organogram-whatsapp";
import { getMergedAreaName } from "@/lib/sales/closing-area-merges";
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
  seat_tier: OrgSeatTier;
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
  /** The department LINK. `employees.department_name` beside it was dropped on 2026-09-29. */
  departments?: { name: string | null } | { name: string | null }[] | null;
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
  /** The team LINK, and now the only source. `employees.team_name` beside it was a denormalized
   *  twin nobody wrote — 0 of 198 rows carried one against 152 real `team_id`s — and it was
   *  dropped on 2026-09-29. The field is gone from this type too, so a read cannot quietly
   *  re-add it to its select and still typecheck. */
  team_id: number | null;
  work_email: string | null;
};

/**
 * The title this source stamps on a seat — and, since 2026-10-01, the ONE copy of it.
 *
 * It lives in `@/lib/org/seat-titles` now because the Phoenix CRM visit card needed the same six
 * strings (the owner: *"put actual titles from the organogram"*) and importing this module for them
 * would have dragged the whole AU read into a CRM server bundle. The values are unchanged; a second
 * hand-typed copy is exactly what would let the organogram and the visit card drift apart.
 */
const TITLE_BY_TIER: Record<AuTreeRow["seat_tier"], string> = ORG_SEAT_TITLE;

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

/**
 * Reads the seat model and returns a full organogram report (all lines).
 *
 * `asOfMonth` (`YYYY-MM`, a finished month) draws the tree as it stood on that month's last day,
 * read from the seat model's own dated history. That is a picture of the STRUCTURE, so it leaves
 * out what only means something today: open offers on empty chairs, and the Head Office branch
 * (assembled from the employee master, which carries no seat dates).
 */
export async function buildOrganogramSeatReport(
  options: { asOfMonth?: string | null } = {},
): Promise<VacancyReportData> {
  const asOfMonth = options.asOfMonth ?? null;
  const supabase = getSupabaseAdmin();

  // THE INDEPENDENT READS START TOGETHER (2026-10-24, the 3.9 s organogram). The seat tree, the
  // offers out, the employee master, the team names and the open Head Office seats never needed
  // each other's answers, yet they were five round trips to Frankfurt, one after another. Each is
  // started here and still awaited at the place that reads it, with its own error handling
  // unchanged. A Supabase query is lazy until something calls `then`, so `Promise.resolve` is what
  // actually starts it. None of these rejects: the queries answer `{ error }` and the offers read
  // swallows its own failures, so a tree read that throws below leaves nothing unhandled. The Head
  // Office seats are read for the live chart only, because a past month returns before using them.
  const offerLoad: Promise<Awaited<ReturnType<typeof loadOfferOutBySeat>>> = asOfMonth
    ? Promise.resolve(new Map())
    : loadOfferOutBySeat();
  const employeeLoad = Promise.resolve(
    supabase
      .from("employees")
      .select(
        "hr_id, full_name, name_ar, work_email, mobile_number, job_title, employment_status, contract_type, contract_renewal_date, hire_date, departments(name), team_id, line_id, manager_hr_id, organogram_visible",
      ),
  );
  const teamLoad = Promise.resolve(supabase.from("teams").select("id, name"));
  const vacancyLoad = asOfMonth
    ? null
    : Promise.resolve(
        supabase
          .from("position_vacancies")
          .select("id, job_title, line_id, manager_hr_id, status")
          .eq("line_id", HEAD_OFFICE_LINE_ID)
          .eq("status", "open"),
      );

  const { data: treeData, error } = asOfMonth
    ? await supabase.rpc("au_f_org_tree_as_of", { p_date: organogramAsOfMonthEnd(asOfMonth) })
    : await supabase
        .from("au_v_org_tree")
        .select(
          "seat_id,parent_seat_id,seat_tier,line_code,region_code,area_code,is_other_pseudo_dm,occupant_hr_id,is_vacant,area_name,region_name,line_name,line_id",
        );
  if (error) throw new Error(`organogram seat source failed: ${error.message}`);
  const tree = (treeData ?? []) as AuTreeRow[];

  // Which empty chairs already have a letter out against them (owner, 2026-09-29). A third round
  // trip, and the cheapest of the three: it reads only offers that name a seat. It swallows its own
  // failures into an empty map, so a vacant seat simply loses its label rather than the chart
  // failing to draw — this decorates the organogram, it never decides what is on it. A past month
  // has no letters out: an offer is a fact about today's empty chair.
  const offerOutBySeat: Awaited<ReturnType<typeof loadOfferOutBySeat>> = await offerLoad;

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
  //
  // 🔴 THE DEPARTMENT COMES FROM ITS LINK, AND THIS READ IS WHY THAT MATTERS. Until 2026-09-29 the
  // select named `department_name`, a denormalized label that was 0 of 198 populated and was then
  // dropped — and PostgREST answers a missing column by failing the WHOLE read, not by nulling one
  // field. So the moment that column went, this select returned nothing and every occupied seat on
  // the organogram lost its occupant's name, hire date and work fields at once. The error was
  // discarded here, which is why it was silent; it is logged now.
  const { data: empData, error: empError } = await employeeLoad;
  if (empError) {
    // Not thrown: the chart still draws from the seat model, as it did while this was broken. But a
    // read that takes every name off the organogram must never again do it without saying so.
    console.error(
      `organogram: the employee master could not be read (${empError.message}); every seat loses its occupant's name and work fields`,
    );
  }

  // THE TEAM NAME COMES FROM THE LINK, AND THERE IS NO LONGER A TWIN BESIDE IT.
  //
  // `employees.team_name` was a denormalized copy that nothing in this codebase wrote: 0 of 198
  // rows carried one against 152 real `team_id`s (2026-09-09: 0 of 107 active, 105 linked), so
  // every organogram surface that showed a team showed an empty one, for everybody, while the team
  // assigned correctly in the data model was unreadable in the one module you would look for it.
  // The column was dropped on 2026-09-29 with the other three labels.
  //
  // A second round trip, accepted for the same reason as the vacancy read below: `teams` is ~120
  // rows and there is nothing to fold it into. It FAILS SOFT — a failed read leaves the map empty
  // and a seat shows no team, rather than taking the whole chart down for a label.
  const teamNameById = new Map<number, string>();
  const { data: teamData, error: teamError } = await teamLoad;
  if (teamError) {
    console.warn(
      `organogram: team names could not be read (${teamError.message}); seats show no team this render`,
    );
  }
  for (const team of (teamData ?? []) as Array<{ id: number | null; name: string | null }>) {
    if (typeof team.id === "number" && team.name?.trim()) teamNameById.set(team.id, team.name.trim());
  }
  /** The link, and only the link — the twin it used to fall back to no longer exists. */
  const teamNameFor = (employee: { team_id?: number | null }): string | null =>
    (typeof employee.team_id === "number" ? teamNameById.get(employee.team_id) : null) ?? null;
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
      employeeDepartmentName: resolveEmployeeDepartmentName(employee),
      employeeJobTitle: employee.job_title,
      employeeTeamName: teamNameFor(employee),
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
      // Pedia folds Fayoum (GZ6) + Beni Suef (UE9) into ONE area "Fayoum - Beni Suef", and CNS does
      // the same from 2026-08 (owner, 2026-09-07). Pedia has a single GZ6 seat and no UE9 seat, so
      // this only renames that node. Anti Infective folds Ismailia (OT9) + Suez (OT2) into ONE area
      // "Ismailia and Suez" from 2026-09 (owner, 2026-09-19): the Delta (3) rep seat sits on OT2, so
      // it reads "Ismailia and Suez" here. On that line Fayoum / Beni Suef stay separate. No period
      // is passed for the LIVE chart on purpose: it shows the org as it stands NOW. An as-of view
      // passes its month, so August reads "Fayoum" and September reads "Ismailia and Suez" exactly
      // as the closings of those months do (a null period means "now" to the rule table).
      areaName: getMergedAreaName(s.line_code, s.area_code ?? "", asOfMonth) ?? s.area_name,
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
      // Only a VACANT seat can carry one. An occupied chair has nothing pending, and reading the
      // map for it would be the first step towards labelling a filled seat with somebody else's
      // letter.
      pendingOffer: occupied ? null : (offerOutBySeat.get(s.seat_id) ?? null),
      status: occupied ? "active" : "open",
      teamId: null,
      teamName: null,
      type: occupied ? "employee" : "vacancy",
      vacancyCode: null,
    });
  }

  // A past month stops here: the Head Office branch below is built from the employee master and
  // `position_vacancies`, neither of which carries the dates to say who held a Head Office role in
  // that month, so including it would draw TODAY's Head Office under a past month's name. The
  // screen says so; the chart never claims what the data cannot back.
  if (asOfMonth) {
    return { organogramRows: rows, rows: [], summary: { ...emptySummary } };
  }

  // The Head Office branch. The AU seat model covers the sales force only — it has no
  // Head Office seats at all — so those employees are assembled from the employee master
  // and hung off the CEO node. Appended here, at the single source every organogram and
  // vacancy-tree caller reads, so the existing boundaries apply to it untouched:
  // `scopeAuOrganogramRows` drops the branch in line mode (its rows name a line) — except a
  // marketer whose OWN line is on the chart, kept with the Head Office managers above him
  // (owner, 2026-10-20) — and `getOrganogramReport` strips it in company mode for anyone without
  // `canAccessHeadOffice`. See organogram-head-office.ts.
  const ceoSeat = tree.find((s) => s.seat_tier === "CEO" && !isDropped(s));
  const occupiedHrIds = new Set<string>();
  // The seat model's own line names by line id (`au.lines`: 1 Anti infective, 2 Pedia, 3 CNS —
  // the same ids `employees.line_id` carries), so a marketer's `ownLineName` is spelled exactly
  // as the sales rows of that line spell theirs. No extra query.
  const lineNameById = new Map<number, string>();
  for (const s of tree) {
    const key = canonicalHrIdKey(s.occupant_hr_id);
    if (key) occupiedHrIds.add(key);
    const lineId = s.line_id == null ? null : Number(s.line_id);
    if (lineId != null && Number.isFinite(lineId) && s.line_name && !lineNameById.has(lineId)) {
      lineNameById.set(lineId, s.line_name);
    }
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
  // Started at the top with the other reads; only a past month (returned above) leaves it unstarted.
  const { data: vacancyData, error: vacancyError } = vacancyLoad
    ? await vacancyLoad
    : { data: null, error: null };
  if (vacancyError) {
    console.warn(
      `organogram: open Head Office seats could not be read (${vacancyError.message}); the chart is drawn without them`,
    );
  }

  const headOfficeRows = buildHeadOfficeOrganogramRows((empData ?? []) as EmployeeWorkRow[], {
    ceoNodeKey: ceoSeat ? (nodeKeyBySeat.get(ceoSeat.seat_id) ?? null) : null,
    occupiedHrIds,
    vacancies: vacancyData ?? [],
    // Head Office vacancies are drawn from `position_vacancies` and have no AU seat, so they are
    // found by the vacancy's own id. Same map, its second key.
    offerOutByVacancyKey: offerOutBySeat,
    // The Head Office branch reads the same employee rows, so it resolves the team the same way.
    // Without this the two halves of one chart would disagree about where a team name comes from.
    teamNameFor,
    lineNameFor: (lineId) => lineNameById.get(lineId) ?? null,
  });

  return { organogramRows: [...rows, ...headOfficeRows], rows: [], summary: { ...emptySummary } };
}

/**
 * Scope the seat rows to the viewer's line(s); CEO (line-less) is always kept.
 *
 * A Head Office row whose `ownLineName` is an allowed line — a Product or Group Product Manager of
 * that line — is kept too, with every row above it on its manager chain (owner, 2026-10-20: the
 * Pedia Product and Group Product Managers were on no Pedia chart, their own included). The chain
 * is what keeps each kept marketer placeable: her Head Office manager is drawn with her. Nothing
 * else of Head Office comes along.
 */
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
  const onAllowedLine = (line: string | null | undefined) => Boolean(line) && allowed.has(normalizeLineName(line));

  // Within one emitted chart a manager pointer is the exact string of its parent's hrId (the seat
  // source and the Head Office branch both emit it that way), so the climb compares raw keys.
  const rowByHrId = new Map<string, OrganogramReportRow>();
  for (const row of rows) {
    if (row.hrId && !rowByHrId.has(row.hrId)) rowByHrId.set(row.hrId, row);
  }
  const keptAncestors = new Set<string>();
  for (const row of rows) {
    if (onAllowedLine(row.lineName) || !onAllowedLine(row.ownLineName)) continue;
    let managerKey = row.managerHrId ?? null;
    while (managerKey && !keptAncestors.has(managerKey)) {
      const manager = rowByHrId.get(managerKey);
      if (!manager) break;
      keptAncestors.add(managerKey);
      managerKey = manager.managerHrId ?? null;
    }
  }

  return rows.filter((row) => {
    if (!row.lineName) return true; // CEO / line-less leadership
    if (onAllowedLine(row.lineName) || onAllowedLine(row.ownLineName)) return true;
    return Boolean(row.hrId) && keptAncestors.has(row.hrId);
  });
}
