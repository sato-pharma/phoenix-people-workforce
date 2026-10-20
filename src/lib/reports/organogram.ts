import {
  type AccessContext,
  normalizeHrId,
  normalizeHrIdForAccess,
  normalizeLineName,
} from "@/lib/auth/permissions";
import { resolveViewerAllowedLines } from "@/lib/auth/scope-visibility";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { applyOrganogramMirrorSafety, seatOccupancyKey } from "@/lib/reports/organogram-safety";
import {
  getVacancyReport,
  isEmployeeVisibleInOrganogram,
  type OrganogramReportRow,
  type VacancyReportData,
  type VacancyReportDiagnostic,
  type VacancyReportRow,
} from "@/lib/reports/vacancies";
import { buildOrganogramSeatReport, scopeAuOrganogramRows } from "@/lib/reports/organogram-au-source";
import { isValidOrganogramAsOfMonth } from "@/lib/reports/organogram-as-of";
import { isFullOrganogramPinnedHrId } from "@/lib/reports/organogram-pinned-accounts";

export type OrganogramScopeMode = "company" | "line";

export type OrganogramReportOptions = {
  /**
   * `YYYY-MM` of a FINISHED month: draw the seat tree as it stood on that month's last day instead
   * of today. Absent is the live chart. The same access checks and scoping apply either way — a
   * past picture never shows a viewer more of the company than today's does.
   */
  asOfMonth?: string | null;
  lineName?: string | null;
  /** Multi-line override: when set, all named lines are shown instead of a single lineName. */
  lineNames?: string[] | null;
  mode: OrganogramScopeMode;
};

const emptyReport = (
  diagnostic?: VacancyReportDiagnostic,
): VacancyReportData => ({
  ...(diagnostic ? { diagnostic } : {}),
  organogramRows: [],
  rows: [],
  summary: {
    areasAffected: 0,
    linesAffected: 0,
    openVacancies: 0,
    positionsAffected: 0,
    totalVacancies: 0,
  },
});

function uniqueCount(values: Array<string | null>) {
  return new Set(values.filter(Boolean)).size;
}

/**
 * Accounts pinned to the FULL company organogram by HR_ID rather than by role.
 *
 * Every other condition in the two gates below names a ROLE, and their comments explain at length
 * why an `access.scope === "company"` shortcut is forbidden: it would admit every current AND
 * future company-scope role in a single edit, silently. This list is the opposite shape and is
 * safe for the same reason — it admits exactly the people written in it and can never widen on
 * its own.
 *
 * A-3 — Samaa Mosaad Khalil, QPPV, Head Office. Owner instruction 2026-09-02: "show the full
 * organogram to sama mosaad account". Her app role is the legacy Head-Office `Manager` rung,
 * which two other people also hold (A-14 Regulatory Affairs, AB R&D Manager). The owner was asked
 * directly whether they should get it too and chose her account alone, so naming the ROLE here —
 * the shape used for the Finance Manager and both HR seats — is precisely what must NOT happen.
 *
 * AB — Dr. Sahar Khalil, R&D Manager, the person the QPPV reports to, pinned the same way (owner,
 * 2026-10-20: the R&D Manager gets the same company chart the QPPV has, Head Office included).
 * Still by HR_ID, never the rung: A-14 Regulatory Affairs stays outside.
 *
 * The list lives in src/lib/reports/organogram-pinned-accounts.ts, dependency-free, because the
 * portal sidebar flag (resolveEmployeePortalNavVisibility in src/lib/employee-portal/navigation.ts)
 * reads the SAME list — the gate that admits a pinned account and the link that offers it cannot
 * drift apart. Her other portal carve-outs (`isA3Account`: Report It and Planning Calendar on, the
 * expense and incentive tabs off) stay hers alone; the pin grants the organogram and nothing else.
 *
 * Compared with hrIdsMatch, never `===`: HR_IDs are stored mixed-case in production (`A-3`,
 * not `a-3`), so a plain comparison matches nobody with no error — which would present as the
 * owner's change never having shipped.
 */
export function isFullOrganogramPinnedAccount(access: Pick<AccessContext, "hrId" | "loginId">) {
  return isFullOrganogramPinnedHrId(access.hrId) || isFullOrganogramPinnedHrId(access.loginId);
}

export function canAccessHeadOffice(access: AccessContext) {
  return (
    // A-3 is Head Office staff herself (QPPV), and so is AB, the R&D Manager she reports to (pinned
    // owner, 2026-10-20). Without this they would hold the company chart and have their own
    // department filtered out of it — the same trap documented for the Finance Manager below, where
    // the one part of the tree the viewer sits in is the part that vanishes.
    isFullOrganogramPinnedAccount(access) ||
    access.role === "Super Admin" ||
    access.role === "CEO" ||
    // Finance Manager added 2026-08-10 (owner). He IS head-office staff (line "Office", line_id 4),
    // so without this the company organogram he was just granted would show him the four sales
    // lines and hide his own department — the one part of the tree he sits in.
    //
    // Named by ROLE, never `access.scope === "company"`. The scope shortcut would hand Head Office
    // to every current and future company-scope caller in one edit.
    //
    // ## How that shortcut is still caught, now that no named role is left outside
    //
    // Every role this helper refuses used to double as the guard — Talent Acquisition until
    // 2026-08-25, then the Training Manager, the SFE Manager and finally the Marketing Manager, all
    // on 2026-09-03. With the Marketing Manager cleared the two functions below name the SAME set,
    // so there is no role left to pin. The guard therefore moved to a SYNTHETIC context and is
    // stronger for it: `ctx("National Sales Manager", "company")` — an unnamed role carrying scope
    // `company` — must be REFUSED, and the same role at scope `system` must PASS. Collapse this
    // body to `access.scope === "company"` and the first flips true and the second false, so both
    // halves fail loudly. That pair no longer depends on any role's real scope, which is what made
    // the old guard fragile.
    //
    // Two corrections worth keeping, because both were asserted confidently and both were wrong.
    // The 2026-09-03 Training Manager commit said Marketing Manager was already the only role
    // outside this helper; the SFE Manager still was too. And every comment here called Marketing
    // Manager "a company-scope role" — `scopeForRole` gives it `line`. The company scope in those
    // tests was always the ctx() helper's synthetic default, never that seat's real scope, so the
    // guard was never measuring what its own comments claimed.
    //
    // The pair lives in tests/organogram-godmode.test.ts, tests/marketing-manager-sees-head-office
    // and tests/finance-manager-six-module-access.test.ts. Keep it in all three.
    access.role === "Finance Manager" ||
    // Talent Acquisition added 2026-08-25 (owner: "in the admin account and talent
    // acquisition show the head office organogram"). She recruits FOR Head Office — the
    // vacancies path already said so in a comment while the code did the opposite, since
    // she passes canAccessCompanyOrganogram and so was caught by that route's
    // `canAccessCompanyOrganogram && !canAccessHeadOffice` strip.
    //
    // This is not a new disclosure. Talent Acquisition already browses the entire employee
    // directory (see hardBoundaryAllowedActions in permissions.ts), so every Head Office
    // person's record was already reachable; this changes which door, not what is behind
    // it. The salary carve-out that governs the directory governs the chart popup too —
    // isSalaryRedactedForViewer blanks the money figures for her own manager chain and the
    // named seniors, and the node-detail route applies it (app/api/reports/organogram/
    // employee/[hrId]/route.ts). Since 2026-09-06 that carve-out is HR ADVISORY'S alone: HR
    // Operations maintains the employee master, salary columns included, so nothing is blanked
    // for her on either surface. (HR Advisory was on this list until the owner retired the HR Business Partner seat on 2026-10-08.)
    access.role === "HR Operations" ||
    // The Talent Acquisition seat (2026-10-08) — Head Office staff who recruits for Head Office too,
    // the reason the old Talent Acquisition role was added here on 2026-08-25.
    access.role === "HR Resourcing" ||
    // The HR Operations Specialist seat (2026-10-20) — Head Office staff herself, given the company
    // chart ("show organogram") the same day. Without this her chart would show the four sales lines
    // and drop the one branch she sits in, the trap written up for the Finance Manager below. Not a
    // new disclosure: she keeps the whole Employee Master (employees:read, canSeeEmployee true), so
    // every Head Office record already opens for her. She IS in canViewOrganogramSensitiveFields —
    // the popup shows her what her Employee Master already does — and every money figure on it is
    // withheld for isSalaryBlindRole.
    access.role === "HR Administration" ||
    // Training Manager added 2026-09-03 (owner: "the training manager ui want to make him able to
    // see full company organogram"). He is the THIRD person to hit the exact defect written up for
    // the Finance Manager above and for A-3 in the pin block above it: he IS Head Office staff, so
    // the company chart he already held showed him the four sales lines and hid the one branch he
    // sits in. Measured on production the same day — A-7 Ahmed Elkawas, line_id 4, manager A-9 —
    // so the chart omitted
    // himself, his own manager (A-9 Marketing Manager) and both of his peers under that manager
    // (A-8, A-10). "Full company organogram" therefore means Head Office, because Head Office was
    // the only thing missing from it.
    //
    // This is not a new disclosure, for a stronger reason than Talent Acquisition's above: the
    // Training-Manager branch in canSeeEmployee (src/lib/auth/permissions.ts) returns true for
    // EVERY employee unconditionally, and he holds employee_profile:read, so every Head Office
    // person's record already opens for him through People Management and Employee 360. This
    // changes which door, not what is behind it.
    //
    // Named by ROLE, never `access.scope === "company"` — the shortcut this whole helper is written
    // to refuse. This entry originally pinned the guard on the Marketing Manager, who was still
    // outside the helper when it was written; he was cleared hours later the same day, so the guard
    // is the synthetic pair described at the top of this function instead. It is not retired.
    //
    // Sensitive fields stay shut. canViewOrganogramSensitiveFields does NOT list him, so he gets
    // the safe org + contact profile and never salary or national ID — the owner's "no pay anywhere
    // near an overview" rule is untouched by this.
    access.role === "Training Manager" ||
    // SFE Manager added 2026-09-03 (owner: "same thing for sfe manager", immediately after the
    // Training Manager above). The FOURTH holder of one defect: he is Head Office staff — A-2
    // Khaled Bedair, line_id 4, reporting to the CEO (AA) — so the company chart he has held since
    // 2026-08-02 showed him the four sales lines and hid the branch containing himself and his own
    // manager. Same shape as the Finance Manager, A-3 and the Training Manager.
    //
    // UNLIKE the Training Manager, this one IS a new disclosure, and the difference is recorded
    // here so nobody re-derives the wrong justification from the entry above. The Training Manager
    // has an unconditional branch in canSeeEmployee, so every Head Office record already opened for
    // him. The SFE Manager has NO such branch: canSeeEmployee falls through to
    // canSeeDirectReportsByRole, which does not list him, so it returns true only for himself. His
    // matrix `payroll`/`payslips` grants do not widen this either — getPayrollScope returns SELF
    // for this seat, so those pages redirect before the grant is ever read. Head Office names,
    // titles and reporting lines are therefore genuinely new to him as of this change; the owner
    // was told that plainly and asked for it anyway.
    //
    // What it is NOT: canViewOrganogramSensitiveFields still does not list him, so he gets the safe
    // org + contact profile and never salary or national ID. And the Vacancy Report does not follow
    // the chart for him the way it does for the Training Manager — his matrix has no `vacancies`
    // key at all, so app/api/reports/vacancies/route.ts refuses him at assertPermission before
    // getScopedVacancyReport's Head Office mirror below is ever reached.
    access.role === "SFE Manager" ||
    // Marketing Manager added 2026-09-03 (owner: "marketing manager also", completing the sweep he
    // began with the Training Manager). The FIFTH and last holder of one defect: A-9 Hossam
    // AboElftouh, line_id 4, reporting to the CEO — Head Office staff, so the company chart he has
    // always held hid the branch containing himself, his own manager, and the three people who
    // report to him (A-7 Training Manager, A-8 GPM, A-10 PM).
    //
    // A new disclosure, like the SFE Manager and unlike the Training Manager: there is no Marketing
    // Manager branch in canSeeEmployee, and getPayrollScope returns SELF for this seat. Unlike the
    // SFE Manager, the Vacancy Report DOES follow the chart here — he holds `vacancies: ["read"]`,
    // so the mirror in getScopedVacancyReport applies to him the way it does to the Training
    // Manager.
    access.role === "Marketing Manager" ||
    access.scope === "system"
  );
}

// Head Office (line_id = 4) serves all lines and is CEO/Super-Admin-only. Detect
// it by the canonical numeric line_id first (rename-safe), falling back to the
// line-name variants for rows whose id isn't populated.
const HEAD_OFFICE_LINE_ID = 4;
export function isHeadOfficeRow(row: { lineId?: number | null; lineName: string | null | undefined }) {
  if (row.lineId === HEAD_OFFICE_LINE_ID) return true;
  const line = row.lineName?.trim().toLowerCase();
  return line === "office" || line === "head office";
}

function lineMatches(actual: string | null | undefined, expected: string | null | undefined) {
  const actualLine = normalizeLineName(actual);
  const expectedLine = normalizeLineName(expected);

  return Boolean(actualLine && expectedLine && actualLine === expectedLine);
}

function recalculateSummary(report: VacancyReportData): VacancyReportData["summary"] {
  const openRows = report.rows.filter((row) => row.status === "open");

  return {
    areasAffected: uniqueCount(openRows.map((row) => row.areaName)),
    linesAffected: uniqueCount(openRows.map((row) => row.lineName)),
    openVacancies: openRows.length,
    positionsAffected: uniqueCount(openRows.map((row) => row.positionTitle ?? row.jobTitle)),
    totalVacancies: report.rows.length,
  };
}

// Shared Head Office suppression so the organogram and the vacancies report apply
// the exact same boundary for non-privileged company viewers.
function stripHeadOfficeRows(report: VacancyReportData): VacancyReportData {
  const filtered = {
    ...report,
    organogramRows: report.organogramRows.filter((row) => !isHeadOfficeRow(row)),
    rows: report.rows.filter((row) => !isHeadOfficeRow(row)),
  };

  return { ...filtered, summary: recalculateSummary(filtered) };
}

export function canAccessCompanyOrganogram(access: AccessContext) {
  return (
    // The account pin — see isFullOrganogramPinnedAccount above. This is gate TWO: with the matrix
    // grant alone she lands in the portal page's redirect, which is the trap each of the three
    // roles named below hit in turn.
    isFullOrganogramPinnedAccount(access) ||
    access.scope === "system" ||
    access.role === "Super Admin" ||
    access.role === "CEO" ||
    access.role === "Marketing Manager" ||
    access.role === "Training Manager" ||
    access.role === "HR Operations" ||
    // The HR Operations Specialist (2026-10-20): "show organogram", with salary hidden.
    access.role === "HR Administration" ||
    // The Talent Acquisition seat (2026-10-08), ticked by the owner. The company chart and its
    // vacancies are what she recruits against. NOT added to canViewOrganogramSensitiveFields: the
    // money on a node stays with the seats that hold payroll.
    access.role === "HR Resourcing" ||
    // Added 2026-08-02 on owner instruction, alongside organogram:read in the matrix. The page
    // has TWO gates: the matrix grant admits him past the first, and without this he fell to the
    // final `redirect("/employee-portals")` — granted on paper, still bounced in practice.
    // Read-only company view; seat and vacancy mutations are gated separately.
    access.role === "SFE Manager" ||
    // Finance Manager added 2026-08-10 (owner) — the SECOND role to hit the two-gate trap described
    // directly above, for the same reason and with the same fix. `organogram: ["read"]` alone gets
    // him past gate one and straight into the redirect. He additionally passes canAccessHeadOffice
    // (unlike the SFE Manager), because he is head-office staff himself.
    access.role === "Finance Manager"
  );
}

export function isPortalOrganogramRole(access: AccessContext) {
  return access.role === "National Sales Manager";
}

// Who may see the SENSITIVE (Personal + Compensation) sections when they press a
// person on the organogram. Deliberately a NARROW allowlist — admins / HR / finance
// only — because the chart's viewer set is wider than that: the line-scoped roles
// (NSM / Regional Manager / Product Manager / GPM) and the company-wide-but-not-HR
// roles (Marketing Manager, Training Manager, SFE Manager) can all open the chart but
// must get only the safe org + contact profile, never salaries or national IDs. This
// keeps the owner's "no pay anywhere near an overview" rule intact while still giving
// the people who already see the full employee master (Employee Management) their
// "all his data" popup. Named by ROLE, never by `scope === "company"`, for the same
// reason canAccessHeadOffice is: a scope shortcut would silently admit every future
// company-scope role. Salary within this set is still subject to isSalaryRedactedForViewer.
export function canViewOrganogramSensitiveFields(access: AccessContext) {
  return (
    access.scope === "system" ||
    access.role === "Super Admin" ||
    access.role === "CEO" ||
    access.role === "Finance Manager" ||
    access.role === "HR Operations" ||
    // The HR Operations Specialist (2026-10-20). She keeps the whole Employee Master — national ID,
    // residence, bank, payment mode — so the popup shows her the same; "the organogram hides
    // salary" (owner) is kept by the two routes, which withhold every money figure for
    // isSalaryBlindRole (isSalaryRedactedForViewer is true for her, and `omitSalary` drops the rows).
    access.role === "HR Administration"
  );
}

export function isLineScopedOrganogramRole(access: AccessContext) {
  // Marketing Manager is intentionally NOT here: it has company-wide oversight via
  // canAccessCompanyOrganogram, so a line-scoped entry was dead code that misrepresented
  // its scope. (Head-of-department company-wide org visibility is the intended behavior.)
  //
  // Regional Manager reads the org tree at LINE grain (same as the NSM above), not region grain:
  // the organogram is a reporting-structure view whose value is seeing where your districts sit
  // inside the whole line, and an RM already has line-wide people visibility through the
  // organogram/team read grants. Sensitive per-person domains (payroll, expenses) stay bounded by
  // their own role-keyed scope resolvers and are unaffected by this.
  //
  // District Manager added 2026-08-22 (owner: the audience picker must be on every organogram,
  // "everyone can copy and paste his scope"). He is the THIRD role to hit the two-gate trap
  // documented in canAccessCompanyOrganogram above, and the last one left holding it: he has
  // carried organogram: ["read"] in defaultPermissionMatrix all along, which admitted him past
  // gate one and dropped him straight into the portal page's redirect, so the grant did nothing
  // at all. LINE grain, not team grain, for exactly the reason given for the Regional Manager
  // directly above — the chart's worth is seeing where your own district sits inside the whole
  // line — and because the report has only company and line modes, never a team one. Sensitive
  // fields stay shut either way: canViewOrganogramSensitiveFields does NOT list him, so he gets
  // the safe org + contact profile (work email included) and never salary or national ID.
  return (
    access.role === "District Manager" ||
    access.role === "National Sales Manager" ||
    access.role === "Regional Manager" ||
    access.role === "Product Manager" ||
    access.role === "Group Product Manager"
  );
}

// Talent Acquisition is now also a canAccessCompanyOrganogram role (2026-07-24), so the
// explicit OR below is redundant but kept — it documents that vacancies visibility for her
// must never regress even if organogram scope changes again independently in the future.
export function canAccessCompanyVacancies(access: AccessContext) {
  return canAccessCompanyOrganogram(access) || access.role === "HR Operations";
}

// District Manager sees only vacancies reporting directly to them (their own team's open
// seats), matching getEmployeePortalVacancies' manager_hr_id scoping.
export function isTeamScopedVacancyRole(access: AccessContext) {
  return access.role === "District Manager";
}

/**
 * Legacy scoping + mirror-safety pass over a pre-built VacancyReportData.
 *
 * SUPERSEDED and NOT on any live route. The organogram chart is built by
 * getOrganogramReport() (seat-model sourced, below) and the Vacancy Report by
 * getScopedVacancyReport(); neither calls this. It survives only as a DB-free surface
 * the organogram unit tests (ceo-organogram-visibility, organogram-empty-diagnostic,
 * organogram-hardening) exercise for scoping / diagnostic / mirror-safety behaviour —
 * so those tests guard THIS function, not the live chart. Do NOT re-wire it into a
 * live path expecting it to "protect" the chart: the live chart is seat-sourced and
 * intentionally skips mirror-safety (see the note in getOrganogramReport). Kept rather
 * than deleted because removing it also means deleting or re-homing those tests — a
 * separate, owner-approved change.
 */
export function scopeOrganogramReportData(
  report: VacancyReportData,
  options: OrganogramReportOptions,
): VacancyReportData {
  if (options.mode === "company") {
    const scopedReport = {
      ...report,
      organogramRows: applyOrganogramMirrorSafety(report.organogramRows),
    };

    return {
      ...scopedReport,
      summary: recalculateSummary(scopedReport),
    };
  }

  // Multi-line override path: when lineNames is provided with ≥1 entry, show all
  // matching lines (e.g. Ahmed Sharaf spanning Pedia + Anti infective).
  if (options.lineNames && options.lineNames.length > 0) {
    const allowedNormalized = options.lineNames.map((l) => normalizeLineName(l)).filter(Boolean);
    const matchesAny = (rowLine: string | null | undefined) => {
      const n = normalizeLineName(rowLine);
      return Boolean(n && allowedNormalized.includes(n));
    };

    // Keep the allowed-line employees AND their management chain upward, so the reporting
    // hierarchy stays connected to the top even when a manager sits on another line — e.g. a
    // Product Manager spanning Pedia + Anti infective still shows his Group Product Manager and,
    // above that, the Marketing Manager who sits on the Head Office line. Without this the line
    // filter orphans the subtree at the first cross-line manager.
    const rowByHrId = new Map<string, OrganogramReportRow>();
    for (const row of report.organogramRows) {
      const key = normalizeHrIdForAccess(row.hrId);
      if (key && !rowByHrId.has(key)) rowByHrId.set(key, row);
    }
    const ancestorHrIds = new Set<string>();
    for (const row of report.organogramRows) {
      if (!matchesAny(row.lineName)) continue;
      let managerKey = normalizeHrIdForAccess(row.managerHrId);
      while (managerKey && !ancestorHrIds.has(managerKey)) {
        ancestorHrIds.add(managerKey);
        const managerRow = rowByHrId.get(managerKey);
        managerKey = managerRow ? normalizeHrIdForAccess(managerRow.managerHrId) : null;
      }
    }
    const keepOrganogramRow = (row: OrganogramReportRow) =>
      matchesAny(row.lineName) || ancestorHrIds.has(normalizeHrIdForAccess(row.hrId) ?? "");

    const scopedReport = {
      ...report,
      organogramRows: applyOrganogramMirrorSafety(
        report.organogramRows.filter(keepOrganogramRow),
      ),
      rows: report.rows.filter((row) => matchesAny(row.lineName)),
    };
    return { ...scopedReport, summary: recalculateSummary(scopedReport) };
  }

  if (!options.lineName) {
    return emptyReport({
      code: "line_unresolved",
      message:
        "We couldn't resolve your line scope. Ask HR to set your `line_name` on the employee record so the organogram can render your team.",
    });
  }

  const scopedReport = {
    ...report,
    organogramRows: applyOrganogramMirrorSafety(
      report.organogramRows.filter((row) => lineMatches(row.lineName, options.lineName)),
    ),
    rows: report.rows.filter((row) => lineMatches(row.lineName, options.lineName)),
  };

  return {
    ...scopedReport,
    summary: recalculateSummary(scopedReport),
  };
}

export async function resolveOrganogramLineForEmployee(access: AccessContext) {
  if (!access.hrId || !isLineScopedOrganogramRole(access)) {
    return null;
  }

  const directory = await getEmployeeDirectory();
  const currentHrId = normalizeHrId(access.hrId);
  const currentEmployee = directory.employees.find(
    (employee) =>
      normalizeHrId(employee.hrId) === currentHrId &&
      isEmployeeVisibleInOrganogram(employee.employmentStatus) &&
      employee.organogramVisible !== false,
  );

  return currentEmployee?.lineName?.trim() || null;
}

/**
 * Like resolveOrganogramLineForEmployee but returns an array when the user has a
 * line_scope_override (e.g. Ahmed Sharaf spanning two lines). Returns null when the
 * role does not use line-scoped organogram access.
 */
export async function resolveOrganogramLinesForEmployee(
  access: AccessContext,
): Promise<string[] | null> {
  if (!access.hrId || !isLineScopedOrganogramRole(access)) return null;

  const [lineOverride, singleLine] = await Promise.all([
    resolveViewerAllowedLines(access),
    resolveOrganogramLineForEmployee(access),
  ]);

  if (lineOverride && lineOverride.length > 0) return lineOverride;
  if (singleLine) return [singleLine];
  return null;
}

export async function getOrganogramReport(
  access: AccessContext,
  options: OrganogramReportOptions = { mode: "company" },
): Promise<VacancyReportData> {
  if (options.mode === "company" && !canAccessCompanyOrganogram(access)) {
    return emptyReport({
      code: "company_scope_denied",
      message:
        "Your role does not have company-wide organogram access. This is enforced server-side; navigation visibility is not the security boundary.",
    });
  }

  if (options.mode === "line" && !isLineScopedOrganogramRole(access)) {
    return emptyReport({
      code: "line_scope_denied",
      message:
        "Your role is not configured for line-scoped organogram access. Contact HR governance if this looks wrong.",
    });
  }

  const hasLineScope =
    (options.lineNames && options.lineNames.length > 0) || Boolean(options.lineName);
  if (options.mode === "line" && !hasLineScope) {
    return emptyReport({
      code: "line_unresolved",
      message:
        "We couldn't resolve your line scope. Ask HR to set your `line_name` on the employee record so the organogram can render your team.",
    });
  }

  // Area-unification rebuild: organogram rows now come from the seat model (au),
  // not the manager_hr_id + job-title heuristics. Access scoping + Head Office
  // stripping are preserved.
  //
  // This live chart path deliberately does NOT run applyOrganogramMirrorSafety
  // (phantom/duplicate/stale-vacancy suppression + public vacancy-code sanitising).
  // That hardening exists to clean the LEGACY position_vacancies-sourced data; the AU
  // seat model is one authoritative row per seat with occupancy-driven filled/vacant,
  // so it produces none of those artefacts and needs no suppression. Mirror-safety is
  // still applied where it IS needed — the flat Vacancy Report in vacancies.ts. The
  // scopeOrganogramReportData() helper below is the OLD (pre-seat-model) scoping path
  // and no longer sits on any live route; see its note.
  //
  // A month that is not finished (or not in the seat model's history) is refused rather than drawn
  // as today: a caller that asked for September must never be handed a chart of another date. The
  // API route has already answered a 400 for this; reaching here means a caller skipped it.
  const asOfMonth = options.asOfMonth ?? null;
  if (asOfMonth !== null && !isValidOrganogramAsOfMonth(asOfMonth)) {
    throw new Error(`organogram as-of month "${asOfMonth}" is not a finished month in the seat history`);
  }
  const seatReport = await buildOrganogramSeatReport({ asOfMonth });
  let scopedRows = scopeAuOrganogramRows(seatReport.organogramRows, options);

  // UNREACHABLE AS OF 2026-09-03, and deliberately kept. `mode: "company"` is only ever passed
  // after canAccessCompanyOrganogram has said yes, and since the Marketing Manager was cleared that
  // function and canAccessHeadOffice name the SAME set — so this condition cannot currently be
  // true and this filter strips nothing from anybody.
  //
  // Do NOT read the presence of this filter as evidence that somebody is being filtered, and do not
  // delete it either. organogram-head-office.ts documents the exact trap in the other direction:
  // canAccessHeadOffice and isHeadOfficeRow spent months filtering a set that was always empty, and
  // "the gate looked healthy because stripping nothing from nothing throws no error." This is the
  // safety net for the next role added to canAccessCompanyOrganogram without Head Office, and
  // tests/marketing-manager-sees-head-office.test.ts fails the moment the two sets diverge again —
  // which is the signal that this line has gone live rather than a defect in its own right.
  if (options.mode === "company" && !canAccessHeadOffice(access)) {
    scopedRows = scopedRows.filter((row) => !isHeadOfficeRow(row));
  }

  // Owner decision (2026-07-30): a Regional Manager sees THEIR OWN region subtree, not the whole
  // product line. Line scope above admits every district on the line — for the live Pedia RM that
  // meant Cairo, Giza and Upper Egypt, districts he does not own. It also made the organogram his
  // WIDEST people view while contracts/attendance/directory were his narrowest. Narrowed here, after
  // the line bound, so the line remains a hard outer limit and this can only ever subtract.
  if (options.mode === "line" && access.role === "Regional Manager") {
    scopedRows = narrowOrganogramRowsToManagerSubtree(scopedRows, access);
  }

  return { organogramRows: scopedRows, rows: [], summary: seatReport.summary };
}

/**
 * Keep only the rows inside a Regional Manager's own seat subtree, plus their own row.
 *
 * Walks the SAME hierarchy the chart renders: the AU seat model, encoded directly in the rows as
 * `managerHrId` (the parent seat's nodeKey) → `hrId` (this seat's nodeKey — the occupant HR_ID when
 * filled, else the stable seat_id). This is deliberately NOT the employee-directory manager chain
 * (`manager_hr_id`). The two can diverge, and when they do the directory version scopes the RM
 * against a different tree than the one drawn on screen: it drops an active rep hanging off a VACANT
 * manager seat (there is no occupant HR_ID for the directory chain to follow up through), and it can
 * pull in people the seat model has re-homed elsewhere. Sourcing the subtree from the rows keeps
 * scope and chart identical by construction, and the line bound above stays a hard outer limit — this
 * can still only ever subtract.
 *
 * Vacant seats are carried exactly like filled ones: their nodeKey (the seat_id) is a node in the
 * walk, so any open seat under the RM — including reps beneath a vacant district — is kept, and the
 * RM still sees every seat they are accountable for.
 *
 * Fails CLOSED: an unresolvable viewer HR_ID yields nothing, and a viewer whose own seat is not
 * among the (already line-scoped) rows collapses to just their own row — never the whole line.
 */
function narrowOrganogramRowsToManagerSubtree(
  rows: OrganogramReportRow[],
  access: AccessContext,
): OrganogramReportRow[] {
  const viewerKey = normalizeHrIdForAccess(access.hrId);
  if (!viewerKey) return [];

  // Adjacency is keyed on RAW nodeKeys: within these rows a child's managerHrId is the exact string
  // of its parent's hrId (both come from the seat source's nodeKey map), so raw equality is precise.
  // normalizeHrIdForAccess is used ONLY to locate the viewer's own node, whose hrId may be formatted
  // differently from access.hrId.
  const childrenByManager = new Map<string, string[]>();
  let viewerNodeKey: string | null = null;
  for (const row of rows) {
    const nodeKey = row.hrId ?? null;
    if (!nodeKey) continue;
    if (viewerNodeKey === null && normalizeHrIdForAccess(nodeKey) === viewerKey) {
      viewerNodeKey = nodeKey;
    }
    const managerKey = row.managerHrId ?? null;
    if (!managerKey) continue;
    const bucket = childrenByManager.get(managerKey);
    if (bucket) bucket.push(nodeKey);
    else childrenByManager.set(managerKey, [nodeKey]);
  }

  // Viewer not present among the line-scoped rows: never widen to the line — show only their own row
  // if it somehow exists, otherwise nothing.
  if (viewerNodeKey === null) {
    return rows.filter((row) => normalizeHrIdForAccess(row.hrId ?? null) === viewerKey);
  }

  // BFS down the seat edges from the RM's node. The visited Set is also the cycle guard, so a
  // malformed parent chain terminates instead of looping.
  const inSubtree = new Set<string>([viewerNodeKey]);
  const queue: string[] = [viewerNodeKey];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const child of childrenByManager.get(node) ?? []) {
      if (!inSubtree.has(child)) {
        inSubtree.add(child);
        queue.push(child);
      }
    }
  }

  return rows.filter((row) => (row.hrId ? inSubtree.has(row.hrId) : false));
}

export function seatKeysOfActiveEmployees(rows: OrganogramReportRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.type !== "employee") continue;
    const key = seatOccupancyKey(row);
    if (key) keys.add(key);
  }
  return keys;
}

// A position_vacancies row claiming "open" is stale when the organogram's own
// occupancy-truth model (buildOrganogramSeatReport, the same seat data /organogram
// renders) shows an active employee currently on that exact seat (level+line+area+
// manager) — the identical signal that already hides a stale vacancy from the
// organogram tree (see suppressFilledVacancyRows in organogram-safety.ts), applied
// here to the flat Vacancy Report's rows/summary so the two surfaces can no longer
// disagree about the same seat. Rows that are already filled/cancelled, or whose
// seat the AU model has no opinion on, pass through untouched — this only removes
// rows that are WRONGLY claiming to still be open.
export function reconcileVacancyRowsAgainstOccupancy(
  rows: VacancyReportRow[],
  occupiedSeatKeys: Set<string>,
): VacancyReportRow[] {
  return rows.filter((row) => {
    if (row.status !== "open") return true;
    const key = seatOccupancyKey(row);
    return !key || !occupiedSeatKeys.has(key);
  });
}

// Builds the vacancy report from the organogram's own AU seat model: the tree
// (organogramRows) IS /organogram's tree, unscoped; the flat list (rows) keeps its
// rich position_vacancies-sourced fields (vacancy code, note, created date, team)
// but has any stale "open" row reconciled away. position_vacancies itself, and the
// hiring/offer-close write path that owns it, are untouched — this only changes
// how the report DISPLAYS filled-vs-vacant, matching the organogram's own logic.
async function buildAuBackedVacancyReport(): Promise<VacancyReportData> {
  const [seatReport, legacyReport] = await Promise.all([
    buildOrganogramSeatReport(),
    getVacancyReport(),
  ]);
  const occupiedSeatKeys = seatKeysOfActiveEmployees(seatReport.organogramRows);
  const rows = reconcileVacancyRowsAgainstOccupancy(legacyReport.rows, occupiedSeatKeys);
  const report: VacancyReportData = {
    organogramRows: seatReport.organogramRows,
    rows,
    summary: legacyReport.summary,
  };
  return { ...report, summary: recalculateSummary(report) };
}

export function scopeAuVacancyReportToLines(
  report: VacancyReportData,
  lineNames: string[],
): VacancyReportData {
  const matchesAny = (line: string | null | undefined) => {
    const n = normalizeLineName(line);
    return Boolean(n && lineNames.some((allowed) => normalizeLineName(allowed) === n));
  };
  const scoped = {
    ...report,
    organogramRows: scopeAuOrganogramRows(report.organogramRows, { lineNames, mode: "line" }),
    rows: report.rows.filter((row) => matchesAny(row.lineName)),
  };
  return { ...scoped, summary: recalculateSummary(scoped) };
}

// District Manager: only vacancies reporting directly to them (their own team's
// open seats), matching the legacy scopeVacancyReportToTeam's exact semantics —
// applied here to the AU-sourced tree/rows instead of the legacy-sourced ones.
export function scopeAuVacancyReportToTeam(
  report: VacancyReportData,
  access: AccessContext,
): VacancyReportData {
  const managerKey = normalizeHrIdForAccess(access.hrId);
  if (!managerKey) {
    return emptyReport({
      code: "team_unresolved",
      message: "We couldn't resolve your HR ID to scope vacancy reports to your team.",
    });
  }

  const matchesManager = (managerHrId: string | null | undefined) =>
    normalizeHrIdForAccess(managerHrId) === managerKey;

  const scoped = {
    ...report,
    organogramRows: report.organogramRows.filter((row) => matchesManager(row.managerHrId)),
    rows: report.rows.filter((row) => matchesManager(row.managerHrId)),
  };
  return { ...scoped, summary: recalculateSummary(scoped) };
}

/**
 * The single scoped entry point for the vacancy report (`app/api/reports/vacancies`,
 * the admin vacancies page, and the admin-shell workspace vacancies page). Classifies
 * the caller's role into company-wide / line-scoped / team-scoped and filters
 * accordingly — mirrors the getOrganogramReport pattern above, extended with the two
 * roles unique to the `vacancies` permission (Talent Acquisition, District Manager).
 *
 * The organogram is the source of truth for filled-vs-vacant: the tree here is the
 * exact same AU seat data /organogram renders, and the flat position_vacancies-
 * sourced list is reconciled against that same occupancy truth before its rows are
 * counted, so the two surfaces can never show disagreeing numbers for one seat.
 */
export async function getScopedVacancyReport(access: AccessContext): Promise<VacancyReportData> {
  if (canAccessCompanyVacancies(access)) {
    const report = await buildAuBackedVacancyReport();
    // Mirror the organogram's Head Office boundary: a company-org role without
    // head-office access (Marketing Manager — the last one left) must not see Head
    // Office vacancies either. Talent Acquisition recruits for Head Office, so it is
    // unaffected; privileged roles (CEO / Super Admin / system) see everything.
    //
    // Training Manager left this strip on 2026-09-03 along with the chart, and that is
    // deliberate rather than incidental: he is Head Office staff, so the open seats
    // beside him are the same disclosure as the filled ones he can now see. Both
    // surfaces move together on purpose — a chart showing a department whose vacancy
    // list silently omits it is how the two were allowed to disagree before.
    //
    // The SFE Manager was cleared for Head Office the same day and does NOT reach this
    // branch at all, which is not an inconsistency: his matrix carries no `vacancies`
    // key, so both vacancy routes refuse him at assertPermission long before scoping.
    // Do not "fix" that by granting him `vacancies` to make the two surfaces match —
    // the owner asked for the organogram, and the report he cannot open cannot disagree
    // with anything.
    //
    // The Marketing Manager followed on the same day, and with him this condition became
    // UNREACHABLE: canAccessCompanyVacancies is built on canAccessCompanyOrganogram, and
    // that function and canAccessHeadOffice now name the SAME set, so a caller who passes
    // the first can no longer fail the second. Kept as the safety net for the next role
    // added to one without the other — see the identical note in getOrganogramReport, and
    // the divergence assertion in tests/marketing-manager-sees-head-office.test.ts that
    // fires when this line goes live again.
    //
    // That sentence about Talent Acquisition described the INTENT, not the behaviour,
    // until 2026-08-25: she passes canAccessCompanyOrganogram and failed
    // canAccessHeadOffice, so this very branch stripped Head Office from her vacancies.
    // Adding her to canAccessHeadOffice is what finally made the comment true.
    if (canAccessCompanyOrganogram(access) && !canAccessHeadOffice(access)) {
      return stripHeadOfficeRows(report);
    }
    return report;
  }

  if (isLineScopedOrganogramRole(access)) {
    const [report, lineNames] = await Promise.all([
      buildAuBackedVacancyReport(),
      resolveOrganogramLinesForEmployee(access),
    ]);

    if (!lineNames || lineNames.length === 0) {
      return emptyReport({
        code: "line_unresolved",
        message:
          "We couldn't resolve your line scope. Ask HR to set your `line_name` on the employee record so vacancies can be scoped to your line.",
      });
    }

    return scopeAuVacancyReportToLines(report, lineNames);
  }

  if (isTeamScopedVacancyRole(access)) {
    const report = await buildAuBackedVacancyReport();
    return scopeAuVacancyReportToTeam(report, access);
  }

  return emptyReport({
    code: "vacancy_scope_denied",
    message:
      "Your role is not configured for vacancy report access. This is enforced server-side; navigation visibility is not the security boundary.",
  });
}
