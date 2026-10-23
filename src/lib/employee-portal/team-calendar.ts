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

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { isNationalSalesManager } from "@/lib/auth/permissions";
import {
  isMedicalRepDirectoryEmployee,
  resolveNsmVacantDsmSeat,
  toCanonicalPortalHrId,
} from "@/lib/employee-portal/service";
import {
  createPortalSalesLineScope,
  employeeMatchesPortalSalesScope,
} from "@/lib/employee-portal/sales-scope";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { attachManagerOwnVisitSplits } from "@/lib/employee-portal/team-calendar-cell";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source";
import { loadManagerOwnVisitDays } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { FieldWorkforcePreviewError } from "@/lib/field-workforce-compliance/preview";
import type { FieldWorkforceEmployeeSummary } from "@/lib/field-workforce-compliance/types";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { formatVacantSeatLabel, resolveSeatGrouping } from "@/lib/workforce/hierarchy-resolver";

export type NsmTeamCalendarStatus = "ok" | "not_ready";

/**
 * One manager followed by their team, recursively (manager first, then everyone who
 * reports to them, directly or through another manager also in this group). Usually a
 * DSM followed by their reps; managerHrId/managerName are null for the safety-net trailing
 * group (duplicate HR IDs / cycles — should not occur with real data).
 */
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
  /**
   * Today in CAIRO, `YYYY-MM-DD` — already computed here by `cairoTodayParts()`, and now handed on
   * to the view so the phone's week stepper opens on the week a manager is actually in. It has to
   * come from the server: the browser would answer in the VIEWER's zone, which AGENTS.md §4 forbids
   * reporting a time in, and would disagree with the server render.
   */
  todayIso: string;
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

/**
 * Where an orphaned rep (real DSM resigned, seat not yet refilled) should actually be
 * grouped: seatKey is either the resigned DSM's own HR ID (continuity marker present) or a
 * synthetic `vacant-seat:<id>` key (marker lost, resolved via the line's single open DSM
 * vacancy instead) — see resolveSeatGrouping. Never a currently-active person's own seat.
 */
type SeatOverride = {
  seatKey: string;
  seatName: string | null;
};

type ResolvedNsmScope = {
  allowedKeys: Set<string>;
  lineName: string | null;
  seatOverridesByHrKey: Map<string, SeatOverride>;
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

  // Seat continuity: when a DSM resigns, their reports get reassigned UP to the NSM
  // (manager_hr_id becomes the NSM's) until a replacement is hired, so a rep's raw
  // managerHrId can no longer identify their real seat. Resolve every medical rep through
  // the same two-tier logic the DSMs/MRs Performance pages use — the resignation trigger's
  // pending-replacement marker first, then the line's single unambiguous open DSM vacancy as
  // a fallback — so an orphaned rep groups under their (vacant) DSM seat in the calendar
  // instead of looking like a standalone manager with no team.
  const nsmCanonical = toCanonicalPortalHrId(access.hrId) ?? toCanonicalPortalHrId(access.loginId);
  const vacantDsmSeat = resolveNsmVacantDsmSeat(directory, scope, nsmCanonical);

  const seatOverridesByHrKey = new Map<string, SeatOverride>();
  for (const employee of directory.employees) {
    if (!isMedicalRepDirectoryEmployee(employee)) continue;
    if (!employeeMatchesPortalSalesScope(employee, scope)) continue;

    const grouping = resolveSeatGrouping(employee, {
      vacantSeatTitle: "DSM seat",
      orphanFallback: {
        isOrphanToNsm: toCanonicalPortalHrId(employee.managerHrId) === nsmCanonical,
        vacantSeat: vacantDsmSeat.seat,
      },
    });
    if (!grouping.isVacant || !grouping.seatHrId) continue;

    const employeeKey = canonicalHrIdKey(employee.hrId);
    if (!employeeKey) continue;
    seatOverridesByHrKey.set(employeeKey, {
      seatKey: grouping.seatKeyIsSynthetic
        ? grouping.seatHrId
        : canonicalHrIdKey(grouping.seatHrId) ?? grouping.seatHrId,
      seatName: grouping.seatName ?? formatVacantSeatLabel(employee, "DSM seat"),
    });
  }

  return { allowedKeys, lineName: scope.lineName, seatOverridesByHrKey };
}

/** True for a District Sales Manager row, by job title/role — see resolveJobFunctionRole. */
function isDistrictManagerSummary(employee: Pick<FieldWorkforceEmployeeSummary, "roleName">): boolean {
  const role: PhoenixRole = resolveJobFunctionRole(employee.roleName);
  return role === "District Manager";
}

/**
 * Arrange the scoped field force by REAL manager/report topology (managerHrId), each "root"
 * — someone whose manager isn't also in the scoped set (e.g. a DSM once the NSM's own row is
 * dropped, or a Regional Manager if one is in-scope above the DSMs) — becomes its own group,
 * followed by everyone recursively reporting to them. Manager HR-ID topology can't
 * misclassify a real manager, it can only ever be right or absent, which is why this mirrors
 * (rather than title-classifies, like the admin WFC classifier's orderEmployeesByHierarchy)
 * the org chart.
 *
 * A DSM is ALWAYS its own group boundary, even when a Regional Manager sits between them and
 * the NSM: every DSM and their own reps get one block, never several DSMs merged into a
 * single block under a shared RSM (a Regional Manager who is in-scope still gets their own
 * group, just with no DSM subtrees flattened into it).
 *
 * `seatOverridesByHrKey` (from resolveNsmScope) redirects orphaned reps — a real DSM
 * resigned, seat not yet refilled, so their raw managerHrId now points at the NSM — to a
 * synthetic/vacant-seat group instead of letting them fall out as a lone false "manager".
 */
export function buildDsmGroups(
  employees: FieldWorkforceEmployeeSummary[],
  seatOverridesByHrKey: ReadonlyMap<string, SeatOverride> = new Map(),
): NsmTeamCalendarGroup[] {
  const byName = (a: FieldWorkforceEmployeeSummary, b: FieldWorkforceEmployeeSummary) =>
    String(a.employeeName).localeCompare(String(b.employeeName), undefined, { numeric: true });
  const keyOf = (employee: FieldWorkforceEmployeeSummary) => canonicalHrIdKey(employee.hrId);

  const presentKeys = new Set(employees.map(keyOf).filter((key): key is string => key != null));
  const childrenByManagerKey = new Map<string, FieldWorkforceEmployeeSummary[]>();
  const vacantSeatLabels = new Map<string, string>();
  const roots: FieldWorkforceEmployeeSummary[] = [];

  for (const employee of employees) {
    const ownKey = keyOf(employee);
    const override = ownKey ? seatOverridesByHrKey.get(ownKey) : undefined;

    if (override) {
      const bucket = childrenByManagerKey.get(override.seatKey) ?? [];
      bucket.push(employee);
      childrenByManagerKey.set(override.seatKey, bucket);
      if (override.seatName) vacantSeatLabels.set(override.seatKey, override.seatName);
      continue;
    }

    const managerKey = canonicalHrIdKey(employee.managerHrId);
    const attachToManager =
      managerKey != null && managerKey !== ownKey && presentKeys.has(managerKey) && !isDistrictManagerSummary(employee);
    if (attachToManager) {
      const bucket = childrenByManagerKey.get(managerKey) ?? [];
      bucket.push(employee);
      childrenByManagerKey.set(managerKey, bucket);
    } else {
      // No manager in the scoped set (e.g. a DSM once the NSM is dropped), or the employee
      // is themself a DSM (always a group boundary, even under an in-scope RSM) -> a root.
      roots.push(employee);
    }
  }

  roots.sort(byName);
  for (const bucket of childrenByManagerKey.values()) bucket.sort(byName);

  // Depth-first flatten of each root's subtree: the root, then its direct reports and
  // theirs, recursively. `visited` guards duplicate HR IDs / cycles from ever looping or
  // double-counting, matching orderEmployeesByHierarchy's safety net.
  const visited = new Set<FieldWorkforceEmployeeSummary>();
  const flatten = (employee: FieldWorkforceEmployeeSummary, out: FieldWorkforceEmployeeSummary[]) => {
    if (visited.has(employee)) return;
    visited.add(employee);
    out.push(employee);
    const key = keyOf(employee);
    for (const child of (key ? childrenByManagerKey.get(key) : undefined) ?? []) flatten(child, out);
  };

  const groups: NsmTeamCalendarGroup[] = roots.map((root) => {
    const members: FieldWorkforceEmployeeSummary[] = [];
    flatten(root, members);
    return { managerHrId: root.hrId, managerName: root.employeeName, members };
  });

  // Vacant-seat groups: a seat key that doesn't match any currently-present employee's HR
  // ID (a resigned DSM's own hrId, or a synthetic vacant-seat:<id> key) still gets its own
  // labeled group instead of being silently absorbed into the trailing safety-net bucket.
  for (const [seatKey, members] of childrenByManagerKey) {
    if (presentKeys.has(seatKey)) continue; // a real employee root already covers this
    members.sort(byName);
    members.forEach((member) => visited.add(member));
    groups.push({
      managerHrId: null,
      managerName: vacantSeatLabels.get(seatKey) ?? "Vacant seat",
      members,
    });
  }

  const unreached = employees.filter((employee) => !visited.has(employee));
  if (unreached.length > 0) {
    groups.push({ managerHrId: null, managerName: null, members: unreached.sort(byName) });
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
    const inLine = preview.employees.filter((employee) => {
      const key = canonicalHrIdKey(employee.hrId);
      return key != null && key !== selfKey && resolved.allowedKeys.has(key);
    });
    // A manager's OWN Phoenix CRM single visits live in a table the visits mirror never carries, so the engine above
    // reads his solo day as nothing (owner, 2026-10-23: "any record submitted by himself … must appear"). Hung on his
    // cells for the square to print, AM · PM · Pharmacies apart; display only, never a status or a deduction.
    const employees = attachManagerOwnVisitSplits(inLine, await loadOwnVisitDaysQuietly(inLine, year, month));

    return {
      employeeCount: employees.length,
      groups: buildDsmGroups(employees, resolved.seatOverridesByHrKey),
      lineName: resolved.lineName,
      message: null,
      month,
      monthLabel: preview.metadata.monthLabel,
      status: "ok",
      todayIso: today.iso,
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
        todayIso: today.iso,
        year,
      };
    }
    throw error;
  }
}

/**
 * The month's own-visit days for the people on the calendar. Best-effort, like every other source beside the mirror:
 * a failed read leaves the squares as the mirror drew them — it can only ever hide a figure, never invent one.
 */
async function loadOwnVisitDaysQuietly(employees: readonly FieldWorkforceEmployeeSummary[], year: number, month: number) {
  const hrIds = employees.map((employee) => employee.hrId).filter(Boolean);
  if (hrIds.length === 0) return [];
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = `${year}-${String(month).padStart(2, "0")}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  try {
    return await loadManagerOwnVisitDays({ end, managerHrIds: hrIds, start });
  } catch (error) {
    console.error("[team-calendar] the managers' own visits could not be read", error);
    return [];
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
