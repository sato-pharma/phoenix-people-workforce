/**
 * NSM Team Calendar — data + line-scoping for the employee-portal "Team Calendar" tab.
 *
 * This is the portal-side, team-scoped slice of the admin Field Workforce Compliance
 * "Team Calendar": it shows each rep in the NATIONAL SALES MANAGER's own line as a
 * month grid of field-visit activity, with green numeric days deep-linking to that
 * rep's day drill-down. It intentionally exposes ONLY the calendar — none of the admin
 * review/deduction workflow.
 *
 * Data source: buildFieldWorkforceCompliancePreviewFromVisitsReport, which reads the
 * iReports360 visits mirror (a fast Postgres read, no external CRM call). We then filter
 * the whole-company preview down to the caller's line using the same portal sales
 * line-scope helpers the DSMs/MRs performance pages use, so an NSM only ever sees their
 * own line's field force. The page/API still gate on the NSM role first; the line filter
 * here is defence-in-depth (safe-by-construction: no line resolved -> no rows).
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { isNationalSalesManager } from "@/lib/auth/permissions";
import {
  createPortalSalesLineScope,
  employeeMatchesPortalSalesScope,
} from "@/lib/employee-portal/sales-scope";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source";
import { FieldWorkforcePreviewError } from "@/lib/field-workforce-compliance/preview";
import type { FieldWorkforceEmployeeSummary } from "@/lib/field-workforce-compliance/types";
import { canonicalHrIdKey } from "@/lib/hr-id";

export type NsmTeamCalendarStatus = "ok" | "not_ready";

/** One DSM followed by the reps who report to them (DSM first, then their team). */
export type NsmTeamCalendarGroup = {
  managerHrId: string | null;
  managerName: string | null;
  members: FieldWorkforceEmployeeSummary[];
};

export type NsmTeamCalendarResult = {
  employeeCount: number;
  groups: NsmTeamCalendarGroup[];
  lineName: string | null;
  message: string | null;
  month: number;
  monthLabel: string | null;
  status: NsmTeamCalendarStatus;
  year: number;
};

/** Cairo-local "today" — the report is an Egyptian field-force calendar. */
function cairoTodayParts(): { iso: string; month: number; year: number } {
  // en-CA formats as YYYY-MM-DD, which is exactly the ISO day string the classifier wants.
  const iso = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
  const [year, month] = iso.split("-").map((part) => Number(part));
  return { iso, month, year };
}

function normalizeMonth(value: number | null | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 12
    ? (value as number)
    : fallback;
}

function normalizeYear(value: number | null | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 2000 && (value as number) <= 2100
    ? (value as number)
    : fallback;
}

type ResolvedNsmScope = {
  allowedKeys: Set<string>;
  lineName: string | null;
};

/**
 * Product / Group Product Managers are marketing roles that ride along on reps' visits, so
 * the visits mirror marks them WFC-eligible. The NSM Team Calendar is a FIELD-FORCE view
 * (DSMs + medical reps), so they are excluded here. Title-based, matching the eligibility
 * classifier; Marketing Manager and other roles are unaffected.
 */
function isProductOrGroupProductManager(
  employee: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">,
): boolean {
  return [employee.positionTitle, employee.jobTitle].some((title) => {
    if (!title) return false;
    const role = resolveJobFunctionRole(title);
    return role === "Product Manager" || role === "Group Product Manager";
  });
}

/**
 * Resolve the caller's line and the canonical HR-ID set of everyone in it. Returns null
 * unless the caller is a National Sales Manager AND we could resolve a concrete line —
 * never falls back to a whole-company (unscoped) set.
 */
async function resolveNsmScope(access: AccessContext): Promise<ResolvedNsmScope | null> {
  if (!isNationalSalesManager(access.role)) return null;

  const key = canonicalHrIdKey(access.hrId) ?? canonicalHrIdKey(access.loginId);
  if (!key) return null;

  const directory = await getEmployeeDirectory();
  const self = directory.employees.find((employee) => canonicalHrIdKey(employee.hrId) === key) ?? null;
  if (!self) return null;

  const scope = createPortalSalesLineScope({
    fallbackLine: self.lineName,
    lineId: self.lineId ?? null,
    lineName: self.lineName ?? null,
  });
  // No resolvable line -> refuse rather than returning an unscoped calendar.
  if (scope.lineId === null && scope.lineCandidates.length === 0) return null;

  const allowedKeys = new Set<string>();
  for (const employee of directory.employees) {
    if (!employeeMatchesPortalSalesScope(employee, scope)) continue;
    // Keep Product / Group Product Managers out of the field-force calendar.
    if (isProductOrGroupProductManager(employee)) continue;
    const employeeKey = canonicalHrIdKey(employee.hrId);
    if (employeeKey) allowedKeys.add(employeeKey);
  }
  allowedKeys.add(key); // the NSM themself always appears

  return { allowedKeys, lineName: scope.lineName };
}

/**
 * Arrange the scoped field force as: each DSM, immediately followed by the reps who report
 * to them (DSM first, then their team), one group per DSM ordered by name. Reps whose DSM
 * isn't in the set (e.g. a vacant DSM seat) and any non-DSM/non-rep still in scope (e.g. a
 * Regional Manager) fall into a trailing "Other" group so nobody is silently dropped.
 */
function buildDsmGroups(employees: FieldWorkforceEmployeeSummary[]): NsmTeamCalendarGroup[] {
  const byName = (a: FieldWorkforceEmployeeSummary, b: FieldWorkforceEmployeeSummary) =>
    String(a.employeeName).localeCompare(String(b.employeeName), undefined, { numeric: true });
  const jobRoleOf = (employee: FieldWorkforceEmployeeSummary) => resolveJobFunctionRole(employee.roleName ?? "");
  const isDsm = (employee: FieldWorkforceEmployeeSummary) => {
    const role = jobRoleOf(employee);
    return role === "District Manager" || role === "Manager";
  };
  const isRep = (employee: FieldWorkforceEmployeeSummary) => jobRoleOf(employee) === "Medical Rep";

  const dsms = [...employees].filter(isDsm).sort(byName);
  const dsmKeys = new Set(dsms.map((dsm) => canonicalHrIdKey(dsm.hrId)).filter((k): k is string => k != null));

  const repsByDsm = new Map<string, FieldWorkforceEmployeeSummary[]>();
  const leftovers: FieldWorkforceEmployeeSummary[] = [];
  for (const employee of employees) {
    if (isDsm(employee)) continue;
    const managerKey = isRep(employee) ? canonicalHrIdKey(employee.managerHrId) : null;
    if (managerKey && dsmKeys.has(managerKey)) {
      const bucket = repsByDsm.get(managerKey) ?? [];
      bucket.push(employee);
      repsByDsm.set(managerKey, bucket);
    } else {
      leftovers.push(employee);
    }
  }

  const groups: NsmTeamCalendarGroup[] = dsms.map((dsm) => {
    const key = canonicalHrIdKey(dsm.hrId);
    const team = (key ? repsByDsm.get(key) ?? [] : []).sort(byName);
    return { managerHrId: dsm.hrId, managerName: dsm.employeeName, members: [dsm, ...team] };
  });

  if (leftovers.length > 0) {
    groups.push({ managerHrId: null, managerName: null, members: leftovers.sort(byName) });
  }

  return groups;
}

/**
 * The Team Calendar for the NSM's line for a given month. Returns null when the caller
 * is not an NSM (or their line can't be resolved). When the visits mirror isn't set up
 * yet, returns status "not_ready" with a human message rather than throwing — so the page
 * reports unavailability instead of a misleading empty calendar.
 */
export async function getNsmTeamCalendar(
  access: AccessContext,
  options: { month?: number | null; year?: number | null } = {},
): Promise<NsmTeamCalendarResult | null> {
  const resolved = await resolveNsmScope(access);
  if (!resolved) return null;

  const today = cairoTodayParts();
  const month = normalizeMonth(options.month, today.month);
  const year = normalizeYear(options.year, today.year);

  try {
    const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({
      month,
      todayIso: today.iso,
      year,
    });

    // Drop the viewer's own row — a "team" calendar shows the NSM's DSMs and reps, not
    // the NSM themself (who would otherwise land in the trailing "Other" group).
    const selfKey = canonicalHrIdKey(access.hrId) ?? canonicalHrIdKey(access.loginId);
    const employees = preview.employees.filter((employee) => {
      const key = canonicalHrIdKey(employee.hrId);
      return key != null && key !== selfKey && resolved.allowedKeys.has(key);
    });

    return {
      employeeCount: employees.length,
      groups: buildDsmGroups(employees),
      lineName: resolved.lineName,
      message: null,
      month,
      monthLabel: preview.metadata.monthLabel,
      status: "ok",
      year,
    };
  } catch (error) {
    if (error instanceof FieldWorkforcePreviewError) {
      return {
        employeeCount: 0,
        groups: [],
        lineName: resolved.lineName,
        message: error.message,
        month,
        monthLabel: null,
        status: "not_ready",
        year,
      };
    }
    throw error;
  }
}

/**
 * Guard for the day drill-down: true only when `hrId` is a rep in the caller's own line
 * (and the caller is an NSM). Keeps the portal visits API from leaking any rep outside
 * the NSM's line.
 */
export async function isHrIdInNsmTeamScope(access: AccessContext, hrId: string): Promise<boolean> {
  const resolved = await resolveNsmScope(access);
  if (!resolved) return false;
  const key = canonicalHrIdKey(hrId);
  return key != null && resolved.allowedKeys.has(key);
}
