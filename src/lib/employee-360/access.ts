// Employee 360 — viewer scoping.
//
// Employee 360 is open to EVERY authenticated role (the route/nav already admit
// anyone with `employee_profile:read`, which is all roles). What differs per role
// is WHICH field-force people a viewer may open. This is a 360-SPECIFIC gate — it
// deliberately does NOT touch the global `canSeeEmployee` (which also guards
// payroll/directory/other sensitive surfaces and must stay narrow).
//
// Scope per role (owner-confirmed 2026-07-18):
//   CEO · SFE Manager · Super Admin (+ system)  → whole company
//   Training Manager                            → all Medical Reps + self only
//   Regional Manager                            → their full multi-level hierarchy + self
//   National Sales Manager · Product Manager · Group Product Manager → their line + self
//   District Manager · Manager                  → their direct team + self
//   Medical Rep · everyone else                 → self only
//
// Subjects are ALWAYS field-force only (the six families in roles.ts). The scope
// predicate below is line/hierarchy-only; the field-force filter is applied by
// `resolveEmployee360VisibleRows` (index) and the role-category card (detail page),
// so a non-field viewer opening their own record still lands on the out-of-scope
// state rather than a broken report.

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveViewerAllowedLines } from "@/lib/auth/scope-visibility";
import { resolveEmployee360RoleCategory } from "@/lib/employee-360/roles";
import { canonicalHrIdKey, hrIdsMatch } from "@/lib/hr-id";
import {
  isWithinManagerHierarchy,
  lineScopeIncludesEmployee,
  reportsToManagerSeat,
  type SeatContinuitySubject,
} from "@/lib/workforce/hierarchy-resolver";

/** Roles that see the WHOLE company in Employee 360. */
const COMPANY_360_ROLES = new Set<PhoenixRole>(["CEO", "SFE Manager", "Super Admin", "Talent Acquisition"]);

/** The subset of an employee row the 360 scope check needs. */
export type Employee360SubjectRow = Pick<
  EmployeeDirectoryRow,
  | "hrId"
  | "managerHrId"
  | "pendingManagerReplacementForHrId"
  | "lineId"
  | "lineName"
  | "departmentId"
  | "departmentName"
  | "jobTitle"
  | "positionTitle"
>;

/** True when a row is a field-force subject (one of the six 360 families). */
export function isEmployee360Subject(
  row: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">,
): boolean {
  return resolveEmployee360RoleCategory(row.jobTitle ?? row.positionTitle) !== null;
}

/**
 * True when this viewer sees the WHOLE company in Employee 360. A company-wide
 * viewer whose own record isn't itself field-force (e.g. Talent Acquisition) gets
 * a browse-all list instead of an out-of-scope card when they open their own
 * profile — see the employee-portal Employee 360 page.
 */
export function isCompany360Viewer(context: Pick<AccessContext, "role" | "scope">): boolean {
  return context.scope === "system" || COMPANY_360_ROLES.has(context.role);
}

/** Precomputed lookups a scope decision reuses across many subjects. */
export type Employee360Scope = {
  /** The viewer's own directory row (for line/department scope), or null. */
  viewer: EmployeeDirectoryRow | null;
  /** Seat-continuity map keyed by canonicalHrIdKey(hrId), for hierarchy climbs. */
  byCanonicalHrId: ReadonlyMap<string, SeatContinuitySubject>;
  /** Lowercased line names this line-scoped viewer may see (from the per-user
   *  line_scope_override) — lets a Group PM span MULTIPLE lines. null = fall back
   *  to the viewer's own single line. */
  allowedLineKeys: ReadonlySet<string> | null;
};

/** Line-scoped roles whose visibility can be widened by a line_scope_override. */
const LINE_SCOPED_ROLES = new Set<PhoenixRole>([
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
]);

/** Build the reusable scope lookups from the full directory for one viewer. */
export async function buildEmployee360Scope(
  rows: EmployeeDirectoryRow[],
  context: AccessContext,
): Promise<Employee360Scope> {
  const viewerKey = canonicalHrIdKey(context.hrId);
  let viewer: EmployeeDirectoryRow | null = null;
  const byCanonicalHrId = new Map<string, SeatContinuitySubject>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hrId);
    if (!key) continue;
    byCanonicalHrId.set(key, {
      managerHrId: row.managerHrId,
      pendingManagerReplacementForHrId: row.pendingManagerReplacementForHrId,
    });
    if (viewerKey && key === viewerKey) viewer = row;
  }
  // A Group PM (or a two-line PM / NSM) can carry a line_scope_override listing
  // every line they oversee. Only fetch it for the line-scoped roles that use it.
  let allowedLineKeys: ReadonlySet<string> | null = null;
  if (LINE_SCOPED_ROLES.has(context.role)) {
    const lines = await resolveViewerAllowedLines(context);
    if (lines && lines.length > 0) {
      allowedLineKeys = new Set(lines.map((l) => l.trim().toLowerCase()).filter(Boolean));
    }
  }
  return { viewer, byCanonicalHrId, allowedLineKeys };
}

/**
 * Pure scope predicate — may this viewer open this subject's 360? Field-force
 * filtering is applied separately so the detail page can still show a friendly
 * out-of-scope card for a non-field person the viewer is otherwise allowed to see.
 */
export function canViewEmployee360Subject(
  context: AccessContext,
  subject: Employee360SubjectRow,
  scope: Employee360Scope,
): boolean {
  if (context.source === "guest" || context.scope === "none") return false;
  if (context.scope === "system" || COMPANY_360_ROLES.has(context.role)) return true;

  // Everyone can open their own record (field-force filter decides what renders).
  if (hrIdsMatch(context.hrId, subject.hrId)) return true;

  const role = context.role;

  // Training Manager oversees the coachable pool: all Medical Reps (+ self above).
  if (role === "Training Manager") {
    return resolveEmployee360RoleCategory(subject.jobTitle ?? subject.positionTitle) === "medical-rep";
  }

  const viewerKey = canonicalHrIdKey(context.hrId);
  if (!viewerKey) return false;

  const employeeSeat: SeatContinuitySubject = {
    managerHrId: subject.managerHrId,
    pendingManagerReplacementForHrId: subject.pendingManagerReplacementForHrId,
  };

  // Regional Manager: their full multi-level management chain.
  if (role === "Regional Manager") {
    return isWithinManagerHierarchy({
      employee: employeeSeat,
      byCanonicalHrId: scope.byCanonicalHrId,
      viewerCanonicalHrId: viewerKey,
      canonicalize: canonicalHrIdKey,
    });
  }

  // District Manager / Manager: their direct team.
  if (role === "District Manager" || role === "Manager") {
    return reportsToManagerSeat({
      employee: employeeSeat,
      viewerCanonicalHrId: viewerKey,
      canonicalize: canonicalHrIdKey,
    });
  }

  // NSM / PM / GPM: their line(s). A line_scope_override (e.g. a Group PM spanning
  // multiple lines) replaces the own-single-line rule with its explicit line set.
  if (
    role === "National Sales Manager" ||
    role === "Product Manager" ||
    role === "Group Product Manager"
  ) {
    if (scope.allowedLineKeys) {
      const subjectLine = String(subject.lineName ?? "").trim().toLowerCase();
      return subjectLine !== "" && scope.allowedLineKeys.has(subjectLine);
    }
    if (!scope.viewer) return false;
    return lineScopeIncludesEmployee(
      {
        lineId: scope.viewer.lineId,
        lineName: scope.viewer.lineName,
        departmentId: scope.viewer.departmentId,
        departmentName: scope.viewer.departmentName,
      },
      {
        lineId: subject.lineId,
        lineName: subject.lineName,
        departmentId: subject.departmentId,
        departmentName: subject.departmentName,
      },
    );
  }

  // Medical Rep / Employee / Finance / Marketing / etc.: self only (handled above).
  return false;
}

/**
 * The field-force rows a viewer may see on the Employee 360 index: in-scope AND a
 * covered role family. This is the single door the index page uses.
 */
export async function resolveEmployee360VisibleRows(
  rows: EmployeeDirectoryRow[],
  context: AccessContext,
): Promise<EmployeeDirectoryRow[]> {
  const scope = await buildEmployee360Scope(rows, context);
  return rows.filter((row) => isEmployee360Subject(row) && canViewEmployee360Subject(context, row, scope));
}
