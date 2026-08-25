/**
 * Head Office branch of the organogram.
 *
 * ## Why this module exists
 *
 * The organogram is drawn from the AU seat model (`au.seats` -> `au_v_org_tree`, read by
 * `buildOrganogramSeatReport`). That model describes the SALES force and nothing else: its
 * seat tiers are CEO / NSM / RSM / DM / ACTING_DM / REP, and every seat below the root
 * carries a sales `line_code`. Head Office has no seats there at all — measured on
 * production 2026-08-25, `au_v_org_tree` held 1 CEO seat plus Anti Infective, Pedia and CNS,
 * and **zero** rows for line_id 4.
 *
 * The consequence was quiet and total: `canAccessHeadOffice` and `isHeadOfficeRow` were
 * filtering a set that was always empty, so the 14 active Head Office employees appeared on
 * NOBODY's chart — not the CEO's, not a Super Admin's. The gate looked healthy because
 * stripping nothing from nothing throws no error.
 *
 * ## Why the branch is built here and NOT inserted into `au.seats`
 *
 * `au.seats` is the spine of sales attribution — `au.line_area_map`, `au.monthly_targets` and
 * `au.monthly_attribution_rollup` all hang off it, and the Office allocation golden rule reads
 * from that same geography. Injecting non-selling, area-less seats into it to satisfy a chart
 * would put real payroll and commission numbers at risk for a presentation problem. The
 * employee master already records this structure correctly (`line_id` = 4 plus
 * `manager_hr_id`), so the branch is assembled from it in the application layer and merged
 * into the emitted rows. No schema change, no migration, nothing sales-facing is touched.
 *
 * ## The two invariants that keep the existing gates working
 *
 * Every row emitted here carries `lineId: 4` AND `lineName: "Head Office"`. Both matter:
 *
 * - `isHeadOfficeRow()` keys off either, so `getOrganogramReport`'s company-mode strip removes
 *   this whole branch for viewers without `canAccessHeadOffice`.
 * - `scopeAuOrganogramRows()` keeps any row whose `lineName` is null ("CEO / line-less
 *   leadership"). A Head Office row left line-less would therefore leak onto every
 *   line-scoped chart — an NSM's Pedia view would sprout the CEO's finance department. Naming
 *   the line is what excludes it from line mode.
 *
 * Get either wrong and the failure is a silent over-disclosure, not a crash.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import { hasWhatsAppNumber } from "@/lib/reports/organogram-whatsapp";
import { isEmployeeVisibleInOrganogram, type OrganogramReportRow } from "@/lib/reports/vacancies";

/** The canonical Head Office line. Mirrors HEAD_OFFICE_LINE_ID in organogram.ts. */
export const HEAD_OFFICE_LINE_ID = 4;

/** The line name written onto every emitted row — see the invariants note above. */
export const HEAD_OFFICE_LINE_NAME = "Head Office";

/**
 * The employee-master columns this branch needs.
 *
 * Read straight off the widened select in `organogram-au-source.ts` rather than a query of
 * its own — the seat source already fetches `employees` in full, and every extra round trip
 * crosses to Frankfurt. Work fields only, same rule as `OrganogramWorkFields`: nothing
 * personal and nothing from payroll ever reaches a chart row.
 */
export type HeadOfficeEmployeeRow = {
  contract_renewal_date?: string | null;
  contract_type?: string | null;
  department_name?: string | null;
  employment_status?: string | null;
  full_name?: string | null;
  hire_date?: string | null;
  hr_id?: string | null;
  job_title?: string | null;
  line_id?: number | null;
  manager_hr_id?: string | null;
  /** Read ONLY to compute the hasWhatsApp boolean — never placed on a row. */
  mobile_number?: string | null;
  name_ar?: string | null;
  organogram_visible?: boolean | null;
  team_name?: string | null;
  work_email?: string | null;
};

export type BuildHeadOfficeRowsOptions = {
  /**
   * The node key of the CEO seat as the seat model emitted it (its occupant HR ID, e.g.
   * "AA"). Head Office people who report to the CEO — and anyone whose manager cannot be
   * resolved inside the branch — hang off this key, so the branch joins the one tree the
   * chart already draws instead of floating as a second root.
   *
   * Null when the seat model has no CEO occupant: the branch is then emitted with no manager
   * and renders as its own root rather than vanishing.
   */
  ceoNodeKey: string | null;
  /**
   * Canonical HR IDs already emitted by the seat model. A person holding both an AU seat and
   * a Head Office employee record would otherwise be drawn twice under one node key — the
   * duplicate-node failure the seat model's own acting-DM collapse exists to prevent.
   */
  occupiedHrIds: ReadonlySet<string>;
};

/** A synthetic, stable seat identity. Prefixed so it can never be read as an `au.seats` id. */
function headOfficeSeatId(hrId: string): string {
  return `HO-${hrId}`;
}

function isHeadOfficeEmployee(employee: HeadOfficeEmployeeRow): boolean {
  if (employee.line_id !== HEAD_OFFICE_LINE_ID) return false;
  if (!employee.hr_id || !employee.hr_id.trim()) return false;
  // `organogram_visible === false` is an explicit "hide this person" flag on the employee
  // master; null/undefined means nothing was ever said, which is not a hide.
  if (employee.organogram_visible === false) return false;
  return isEmployeeVisibleInOrganogram(employee.employment_status);
}

/**
 * Build the Head Office rows.
 *
 * Pure by design — it takes the already-fetched employee rows and returns chart rows, so the
 * placement rules are unit-testable with no database and no network.
 */
export function buildHeadOfficeOrganogramRows(
  employees: HeadOfficeEmployeeRow[],
  options: BuildHeadOfficeRowsOptions,
): OrganogramReportRow[] {
  const { ceoNodeKey, occupiedHrIds } = options;
  const ceoKey = ceoNodeKey ? canonicalHrIdKey(ceoNodeKey) : null;

  // The people this branch will draw: Head Office, visible, not already on an AU seat, and
  // never the CEO himself — the seat model emits him as the root and a second row would
  // collide on his node key.
  const branch = employees.filter((employee) => {
    if (!isHeadOfficeEmployee(employee)) return false;
    const key = canonicalHrIdKey(employee.hr_id);
    if (!key) return false;
    if (ceoKey && key === ceoKey) return false;
    return !occupiedHrIds.has(key);
  });

  // Canonical key -> the HR ID string exactly as it will be emitted, so a manager pointer
  // matches the child's `hrId` byte for byte. HR IDs are stored in mixed case in this
  // database, so every comparison goes through canonicalHrIdKey and only the OUTPUT keeps
  // the stored casing.
  const emittedHrIdByKey = new Map<string, string>();
  const nameByKey = new Map<string, string>();
  for (const employee of branch) {
    const key = canonicalHrIdKey(employee.hr_id)!;
    const hrId = employee.hr_id!.trim();
    emittedHrIdByKey.set(key, hrId);
    nameByKey.set(key, employee.full_name?.trim() || hrId);
  }

  /** The manager key this person points at, before cycle checking. */
  const parentKeyOf = (employee: HeadOfficeEmployeeRow): string | null => {
    const managerKey = canonicalHrIdKey(employee.manager_hr_id);
    if (managerKey && emittedHrIdByKey.has(managerKey)) return managerKey;
    // Reports to the CEO, reports to somebody outside Head Office, or has no manager on
    // file: hang off the CEO. Re-homing rather than orphaning is deliberate — an
    // unresolvable pointer would drop the person off the chart entirely, which is the
    // failure this whole module exists to fix.
    return ceoKey;
  };

  // A cycle in `employees.manager_hr_id` (A reports to B, B reports to A) would make the
  // client's tree-climb loop forever. Walk each chain to its root once and re-home anyone
  // who cannot reach the CEO within the branch's own size.
  const resolvedParentKey = new Map<string, string | null>();
  for (const employee of branch) {
    const key = canonicalHrIdKey(employee.hr_id)!;
    resolvedParentKey.set(key, parentKeyOf(employee));
  }
  const parentByKey = new Map<string, string | null>(resolvedParentKey);
  for (const [key] of resolvedParentKey) {
    const seen = new Set<string>([key]);
    let cursor = resolvedParentKey.get(key) ?? null;
    while (cursor && emittedHrIdByKey.has(cursor)) {
      if (seen.has(cursor)) {
        // Cycle — break it at this node by re-homing to the CEO.
        parentByKey.set(key, ceoKey);
        break;
      }
      seen.add(cursor);
      cursor = resolvedParentKey.get(cursor) ?? null;
    }
  }

  const rows: OrganogramReportRow[] = [];
  for (const employee of branch) {
    const key = canonicalHrIdKey(employee.hr_id)!;
    const hrId = emittedHrIdByKey.get(key)!;
    const parentKey = parentByKey.get(key) ?? null;

    let managerHrId: string | null = null;
    let managerName: string | null = null;
    if (parentKey && emittedHrIdByKey.has(parentKey)) {
      managerHrId = emittedHrIdByKey.get(parentKey)!;
      managerName = nameByKey.get(parentKey) ?? null;
    } else if (parentKey && ceoKey && parentKey === ceoKey) {
      managerHrId = ceoNodeKey;
      // Left null on purpose: the seat model owns the CEO's row and his display name. The
      // chart resolves a manager's name from the manager's own node, so naming him here
      // would only risk disagreeing with it.
      managerName = null;
    }

    const title = employee.job_title?.trim() || null;

    rows.push({
      contractRenewalDate: employee.contract_renewal_date ?? null,
      contractType: employee.contract_type ?? null,
      employeeDepartmentName: employee.department_name ?? null,
      employeeJobTitle: title,
      employeeTeamName: employee.team_name ?? null,
      employmentStatus: employee.employment_status ?? null,
      hasWhatsApp: hasWhatsAppNumber(employee.mobile_number ?? null),
      nameAr: employee.name_ar ?? null,
      workEmail: employee.work_email ?? null,

      areaId: null,
      areaName: null,
      departmentId: null,
      // Stays null exactly as on the seat path: `departmentName` feeds chart
      // classification, and the employee master's value reaches the export through
      // `employeeDepartmentName` instead. See OrganogramWorkFields.
      departmentName: null,
      displayName: nameByKey.get(key)!,
      fullName: nameByKey.get(key)!,
      hireDate: employee.hire_date ?? null,
      hrId,
      jobTitle: title,
      // Both set — see the invariants note in this file's header. Neither is optional.
      lineId: HEAD_OFFICE_LINE_ID,
      lineName: HEAD_OFFICE_LINE_NAME,
      managerHrId,
      managerName,
      managerReplacementForHrId: null,
      positionId: null,
      positionTitle: title,
      regionName: null,
      replacementForHrId: null,
      seatId: headOfficeSeatId(hrId),
      sourceRowNumber: null,
      status: "active",
      teamId: null,
      teamName: null,
      // Head Office is sourced from real employee records, so every row is a filled seat.
      // The branch carries no vacancies: open Head Office roles live in
      // `position_vacancies` and reach the Vacancy Report through its own path.
      type: "employee",
      vacancyCode: null,
    });
  }

  // Stable, name-ordered output so two renders of the same data draw the same chart.
  return rows.sort((a, b) => a.displayName.localeCompare(b.displayName, "en"));
}
