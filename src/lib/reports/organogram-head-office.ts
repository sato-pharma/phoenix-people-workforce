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
 * ## Membership is the MANAGER CHAIN, not `line_id` alone (2026-08-28)
 *
 * `line_id = 4` was the whole membership test until the owner reported that the marketing
 * branch was missing its product managers. It was: measured on production that day, three
 * active people held NO AU seat and were not line 4 —
 *
 *     Nahed Tarek Hattab (A-10)      Product Manager        line 1, reports to A-9
 *     Rasha Sabry Khalifa (A-8)      Group Product Manager  line 2, reports to A-9
 *     Ahmed Sharaf Eldeen (B-155)    Product Manager        line 2, reports to A-8
 *
 * — and all three were absent from every chart in the system. Their `line_id` is not a
 * mistake to be corrected: it records which product line a marketer markets, and it feeds
 * sales attribution, targets and incentives. Rewriting it to 4 to fix a chart would move real
 * money. So membership became the question that actually matches the org: **does this person's
 * manager chain reach Head Office, and do they hold no sales seat?** Line 4 employees seed the
 * set; anyone unseated reporting into it joins, transitively.
 *
 * The seat check is what keeps this tight rather than sprawling. Every member of the sales
 * force holds an `au.seats` row, so a rep can never be pulled in by reporting to a District
 * Manager who reports upward into Head Office — the DM and the rep both hold seats and are
 * both excluded. Re-measured on the same data: the rule admits exactly those three people and
 * nobody else.
 *
 * ## Open Head Office seats are drawn too (2026-08-28)
 *
 * The AU path renders an unfilled sales seat as a vacancy node, so the chart already shows
 * open seats — but only sales ones. Head Office had no such thing, and its open roles do
 * exist: `position_vacancies` auto-opens one on every resignation, which is how the two HR
 * seats vacated on 31 August already had rows waiting. They simply reached the Vacancy Report
 * and never the chart, so the HR department rendered as a manager with nobody under him.
 *
 * Only `line_id = 4` vacancies are emitted here. A sales vacancy already arrives from its own
 * unfilled `au.seats` row, and emitting it a second time from `position_vacancies` would draw
 * one open seat as two — the duplicate-node failure the acting-DM collapse exists to prevent.
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
 *
 * That applies to the marketers pulled in by manager chain as well, and it is deliberate that
 * they are stamped Head Office rather than their own product line. A row is only placeable if
 * its manager is on the same chart: stamping a Product Manager "Anti Infective" would keep her
 * on a line-scoped Anti Infective view while her manager — the Marketing Manager, a Head
 * Office row — was stripped from it, leaving her hanging off a parent that is not there.
 *
 * ## …but a line chart still finds them, through `ownLineName` (owner, 2026-10-20)
 *
 * Stamped Head Office and nothing else, the marketers left EVERY line chart — the Pedia Product
 * and Group Product Managers were missing from each Pedia chart, their own included, although they
 * are line-scoped viewers of exactly that line (owner: "every single role that is applicable to
 * appear in a module — find it and show it"). So a marketer's row also carries `ownLineName`, the
 * sales line its `line_id` names, while `lineId`/`lineName` stay Head Office for the gates above.
 * Line mode (`scopeAuOrganogramRows`) keeps a row whose `ownLineName` is on the chart AND the Head
 * Office managers above it, so the placement rule still holds: she never hangs off a parent that
 * is not drawn. A line-4 person (the Training Manager, Finance, HR) carries no `ownLineName` and
 * still never rides onto a line chart — only the managers on a kept marketer's own chain do.
 */

import { resolveEmployeeDepartmentName } from "@/lib/employees/employee-org-labels";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { offerSeatKeyForVacancy, type SeatOfferOut } from "@/lib/offers/seat-offer-label";
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
  /** The department LINK. `employees.department_name` beside it was 0 of 198 and was dropped. */
  departments?: { name: string | null } | { name: string | null }[] | null;
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
  /** The team link, and the only source: `employees.team_name` beside it was a twin nothing wrote
   *  (0 of 198) and was dropped on 2026-09-29. A caller that can resolve the link passes
   *  `teamNameFor` below; one that cannot gets no team rather than a blank pretending to be one. */
  team_id?: number | null;
  work_email?: string | null;
};

/**
 * An open Head Office seat, from `position_vacancies`.
 *
 * Deliberately a narrow shape: a vacancy row also carries a `note` naming the person who
 * resigned and a public `vacancy_code`, and neither belongs on a chart node. Only the seat's
 * title and where it hangs are read.
 */
export type HeadOfficeVacancyRow = {
  id?: number | null;
  job_title?: string | null;
  line_id?: number | null;
  manager_hr_id?: string | null;
  status?: string | null;
};

export type BuildHeadOfficeRowsOptions = {
  /**
   * Seat-key -> the offer already out against that chair (owner, 2026-09-29). A Head Office
   * vacancy has no AU seat, so it is found by `offerSeatKeyForVacancy(vacancy.id)`. Optional and
   * defaulting to empty, so every existing caller emits exactly what it emitted before.
   */
  offerOutByVacancyKey?: Map<string, SeatOfferOut>;
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
   *
   * This set is also what bounds the manager-chain expansion above: holding a sales seat is
   * what makes someone a sales-force member rather than a marketer reporting into Head Office.
   */
  occupiedHrIds: ReadonlySet<string>;
  /**
   * Open `position_vacancies` rows. Optional so every existing caller and test keeps working
   * unchanged and simply draws no open Head Office seats.
   */
  vacancies?: HeadOfficeVacancyRow[];
  /**
   * Resolves an employee's team NAME from their `team_id`, because `employees.team_name` was a
   * denormalized twin nothing wrote — 0 of 107 active employees carried it on 2026-09-09, 0 of 198
   * when it was dropped on 2026-09-29.
   *
   * Optional. The default now returns null rather than reading the twin: the twin is gone, and a
   * default that still named it would be a column reference waiting to be re-added. A caller that
   * can resolve the link (the seat source) passes this in.
   */
  teamNameFor?: (employee: HeadOfficeEmployeeRow) => string | null;
  /**
   * Resolves a sales `line_id` to its line name, for `ownLineName` (owner, 2026-10-20 — see the
   * header). The seat source passes the seat model's own line names. Optional: without it no row
   * carries an own line and the branch behaves exactly as before.
   */
  lineNameFor?: (lineId: number) => string | null;
};

/** A synthetic, stable seat identity. Prefixed so it can never be read as an `au.seats` id. */
function headOfficeSeatId(hrId: string): string {
  return `HO-${hrId}`;
}

/**
 * The node key of an open Head Office seat.
 *
 * Keyed on the vacancy's row id, NOT its `vacancy_code`. The code is a public-facing string
 * that `applyOrganogramMirrorSafety` sanitises out of shared reports; putting it in a node key
 * would smuggle it back onto the chart through a field nothing thinks to sanitise.
 */
function headOfficeVacancyNodeKey(vacancyId: number): string {
  return `HO-VAC-${vacancyId}`;
}

/** Line-4 and currently open. */
function isOpenHeadOfficeVacancy(vacancy: HeadOfficeVacancyRow): boolean {
  if (vacancy.line_id !== HEAD_OFFICE_LINE_ID) return false;
  if (typeof vacancy.id !== "number") return false;
  return (vacancy.status ?? "").trim().toLowerCase() === "open";
}

/** Active, visible, and identifiable — the floor for appearing on the chart at all. */
function isChartEligibleEmployee(employee: HeadOfficeEmployeeRow): boolean {
  if (!employee.hr_id || !employee.hr_id.trim()) return false;
  // `organogram_visible === false` is an explicit "hide this person" flag on the employee
  // master; null/undefined means nothing was ever said, which is not a hide.
  if (employee.organogram_visible === false) return false;
  return isEmployeeVisibleInOrganogram(employee.employment_status);
}

/** The seed of the branch: everyone the employee master files under Head Office. */
function isHeadOfficeEmployee(employee: HeadOfficeEmployeeRow): boolean {
  if (employee.line_id !== HEAD_OFFICE_LINE_ID) return false;
  return isChartEligibleEmployee(employee);
}

/**
 * Build the Head Office rows.
 *
 * Pure by design — it takes the already-fetched employee and vacancy rows and returns chart
 * rows, so the placement rules are unit-testable with no database and no network.
 */
export function buildHeadOfficeOrganogramRows(
  employees: HeadOfficeEmployeeRow[],
  options: BuildHeadOfficeRowsOptions,
): OrganogramReportRow[] {
  const {
    ceoNodeKey,
    occupiedHrIds,
    vacancies = [],
    offerOutByVacancyKey,
    // No team unless a caller can resolve the link. The twin this used to default to is gone, and
    // it was blank on every row anyway — so this default emits exactly what it emitted before.
    teamNameFor = () => null,
    lineNameFor = () => null,
  } = options;
  const ceoKey = ceoNodeKey ? canonicalHrIdKey(ceoNodeKey) : null;

  // Everyone who could appear here: visible, not already on an AU seat, and never the CEO
  // himself — the seat model emits him as the root and a second row would collide on his
  // node key.
  const candidates = employees.filter((employee) => {
    if (!isChartEligibleEmployee(employee)) return false;
    const key = canonicalHrIdKey(employee.hr_id);
    if (!key) return false;
    if (ceoKey && key === ceoKey) return false;
    return !occupiedHrIds.has(key);
  });

  // Seed with Head Office proper, then absorb anyone unseated who reports into the set —
  // repeatedly, because a chain can be several deep (a Product Manager reports to a Group
  // Product Manager who reports to the Marketing Manager). Each pass can only ADD, and a
  // candidate is admitted once, so this terminates in at most `candidates.length` passes
  // even if `manager_hr_id` contains a cycle.
  const branchKeys = new Set<string>();
  for (const employee of candidates) {
    if (isHeadOfficeEmployee(employee)) branchKeys.add(canonicalHrIdKey(employee.hr_id)!);
  }
  for (let pass = 0; pass < candidates.length; pass += 1) {
    let added = false;
    for (const employee of candidates) {
      const key = canonicalHrIdKey(employee.hr_id)!;
      if (branchKeys.has(key)) continue;
      const managerKey = canonicalHrIdKey(employee.manager_hr_id);
      // Reporting DIRECTLY to the CEO is not enough on its own to join the branch: the CEO is
      // the root of the whole company, so admitting on that alone would pull the sales
      // National Sales Managers in. Only a manager already inside the branch counts.
      if (managerKey && branchKeys.has(managerKey)) {
        branchKeys.add(key);
        added = true;
      }
    }
    if (!added) break;
  }
  const branch = candidates.filter((employee) =>
    branchKeys.has(canonicalHrIdKey(employee.hr_id)!),
  );

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

  /** Resolve a manager pointer to the (managerHrId, managerName) a chart row carries. */
  const managerFieldsFor = (
    parentKey: string | null,
  ): { managerHrId: string | null; managerName: string | null } => {
    if (parentKey && emittedHrIdByKey.has(parentKey)) {
      return {
        managerHrId: emittedHrIdByKey.get(parentKey)!,
        managerName: nameByKey.get(parentKey) ?? null,
      };
    }
    if (parentKey && ceoKey && parentKey === ceoKey) {
      return {
        managerHrId: ceoNodeKey,
        // Left null on purpose: the seat model owns the CEO's row and his display name. The
        // chart resolves a manager's name from the manager's own node, so naming him here
        // would only risk disagreeing with it.
        managerName: null,
      };
    }
    return { managerHrId: null, managerName: null };
  };

  const rows: OrganogramReportRow[] = [];
  for (const employee of branch) {
    const key = canonicalHrIdKey(employee.hr_id)!;
    const hrId = emittedHrIdByKey.get(key)!;
    const { managerHrId, managerName } = managerFieldsFor(parentByKey.get(key) ?? null);

    const title = employee.job_title?.trim() || null;

    rows.push({
      contractRenewalDate: employee.contract_renewal_date ?? null,
      contractType: employee.contract_type ?? null,
      employeeDepartmentName: resolveEmployeeDepartmentName(employee),
      employeeJobTitle: title,
      employeeTeamName: teamNameFor(employee),
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
      // A marketer's own sales line, so a line chart can keep him (owner, 2026-10-20). Head Office
      // proper (line 4) carries none.
      ownLineName:
        typeof employee.line_id === "number" && employee.line_id !== HEAD_OFFICE_LINE_ID
          ? lineNameFor(employee.line_id)
          : null,
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
      type: "employee",
      vacancyCode: null,
    });
  }

  // Open Head Office seats. Emitted AFTER the people, so a vacancy can hang off a manager
  // who was pulled in by the chain expansion above.
  for (const vacancy of vacancies) {
    if (!isOpenHeadOfficeVacancy(vacancy)) continue;

    const managerKey = canonicalHrIdKey(vacancy.manager_hr_id);
    // A vacancy whose manager is not on this chart hangs off the CEO, the same re-homing the
    // people path uses. Dropping it instead would hide a real open seat.
    const parentKey = managerKey && emittedHrIdByKey.has(managerKey) ? managerKey : ceoKey;
    const { managerHrId, managerName } = managerFieldsFor(parentKey);

    const title = vacancy.job_title?.trim() || null;
    const nodeKey = headOfficeVacancyNodeKey(vacancy.id as number);

    rows.push({
      // No employee sits here, so every work field is empty rather than invented — the same
      // choice the seat path makes for a vacant sales seat.
      contractRenewalDate: null,
      contractType: null,
      employeeDepartmentName: null,
      employeeJobTitle: null,
      employeeTeamName: null,
      employmentStatus: null,
      hasWhatsApp: false,
      nameAr: null,
      workEmail: null,

      areaId: null,
      areaName: null,
      departmentId: null,
      departmentName: null,
      // "Vacant" is the seat path's word for an unfilled seat; the chart renders its own
      // "Open Vacancy" label and never prints this, but the two paths agreeing keeps an
      // export or a diff from showing two names for one thing.
      displayName: "Vacant",
      fullName: "Vacant",
      hireDate: null,
      hrId: nodeKey,
      jobTitle: title,
      lineId: HEAD_OFFICE_LINE_ID,
      lineName: HEAD_OFFICE_LINE_NAME,
      managerHrId,
      managerName,
      managerReplacementForHrId: null,
      positionId: null,
      positionTitle: title,
      regionName: null,
      replacementForHrId: null,
      pendingOffer: offerOutByVacancyKey?.get(offerSeatKeyForVacancy(vacancy.id as number)) ?? null,
      seatId: nodeKey,
      sourceRowNumber: null,
      status: "open",
      teamId: null,
      teamName: null,
      type: "vacancy",
      // Never the real code. See headOfficeVacancyNodeKey.
      vacancyCode: null,
    });
  }

  // Stable, name-ordered output so two renders of the same data draw the same chart.
  // Vacancies all share the displayName "Vacant", so they tie-break on their node key rather
  // than landing in whatever order the query returned them.
  return rows.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName, "en") ||
      String(a.hrId ?? "").localeCompare(String(b.hrId ?? ""), "en"),
  );
}
