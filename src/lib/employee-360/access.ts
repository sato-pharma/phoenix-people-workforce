// Employee 360 — viewer scoping.
//
// Employee 360 is open to EVERY authenticated role (the route/nav already admit
// anyone with `employee_profile:read`, which is all roles). What differs per role
// is WHICH field-force people a viewer may open. This is a 360-SPECIFIC gate — it
// deliberately does NOT touch the global `canSeeEmployee` (which also guards
// payroll/directory/other sensitive surfaces and must stay narrow).
//
// Scope per role (owner-confirmed 2026-07-18; Talent Acquisition narrowed to
// Medical Reps only 2026-07-26; Marketing Manager added to line scope 2026-08-09):
//   CEO · SFE Manager · Super Admin (+ system)  → whole company
//   Training Manager · HR Advisory · HR Operations → all Medical Reps + self only
//   Regional Manager                            → their full multi-level hierarchy + self
//   National Sales Manager · Product Manager · Group Product Manager · Marketing Manager → their line + self
//     (the three Marketing-department roles see their line's field force BELOW them across
//     departments — owner, 2026-10-20; see MARKETING_LINE_360_ROLES and its downward reach)
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
import { type Employee360RoleCategory, resolveEmployee360RoleCategory } from "@/lib/employee-360/roles";
import { canonicalHrIdKey, hrIdsMatch } from "@/lib/hr-id";
import {
  isWithinManagerHierarchy,
  lineScopeIncludesEmployee,
  sameWorkforceDepartment,
  sameWorkforceLine,
  type SeatContinuitySubject,
} from "@/lib/workforce/hierarchy-resolver";

/** Roles that see the WHOLE company in Employee 360. */
const COMPANY_360_ROLES = new Set<PhoenixRole>(["CEO", "SFE Manager", "Super Admin"]);

/** Roles restricted to Medical Reps only (+ self), company-wide — no line/hierarchy scope. */
// HR Resourcing — the Talent Acquisition seat — sits with the other two HR seats (2026-10-08):
// company-wide, medical reps only.
const MEDICAL_REP_ONLY_360_ROLES = new Set<PhoenixRole>([
  "Training Manager",
  "HR Operations",
  "HR Resourcing",
]);

/**
 * Employees removed from Employee 360 entirely — a per-person business decision, not a role rule.
 *
 * Nobody may open a listed person's report — not the whole-company roles, not their own manager, and
 * not the person themselves. Keyed by HR_ID (same shape as TALENT_ACQUISITION_SALARY_REDACTED_HR_IDS
 * in src/lib/auth/permissions.ts) and compared through canonicalHrIdKey, so "AB-0001" and "AB0001"
 * both match.
 *
 * EMPTY since the owner reversed the only entry (owner, 2026-10-20: "bring him back but do not show
 * empty data, tailor the report on him"). The Regional Sales Manager listed here on 2026-07-30 is a
 * 360 subject again, and his report is tailored to a regional manager in
 * planEmployee360Sections (src/lib/employee-360/report-sections.ts). The mechanism stays so a future
 * per-person removal is one line; never re-add him without the owner's word.
 */
const EMPLOYEE_360_EXCLUDED_SOURCE_HR_IDS: readonly string[] = [];
const EMPLOYEE_360_EXCLUDED_HR_IDS: ReadonlySet<string> = new Set(
  EMPLOYEE_360_EXCLUDED_SOURCE_HR_IDS.map((hrId) => canonicalHrIdKey(hrId)).filter((key): key is string => Boolean(key)),
);

/** True when this person is excluded from Employee 360 for every viewer, including themselves. */
export function isEmployee360ExcludedSubject(hrId: string | null | undefined): boolean {
  const key = canonicalHrIdKey(hrId);
  return key !== null && EMPLOYEE_360_EXCLUDED_HR_IDS.has(key);
}

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
 * True when this viewer's own non-field-force record should fall back to a
 * browse-all-visible-subjects list instead of an out-of-scope card when they
 * open their own profile — see the employee-portal Employee 360 page. This
 * covers both whole-company viewers (CEO / SFE Manager / Super Admin) and
 * Medical-Rep-only viewers (Talent Acquisition); which subjects actually show
 * up in that list is still decided by `canViewEmployee360Subject`.
 */
export function isCompany360Viewer(context: Pick<AccessContext, "role" | "scope">): boolean {
  return (
    context.scope === "system" ||
    COMPANY_360_ROLES.has(context.role) ||
    MEDICAL_REP_ONLY_360_ROLES.has(context.role)
  );
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
  "Marketing Manager",
]);

/**
 * The line-scoped viewers who sit in the MARKETING department while the line they oversee is
 * worked by the SALES field force. Owner, 2026-10-20: "every single role that is applicable to
 * appear in a module — find it and show it." The department-safe line rule (same line AND same
 * department) left these three with no medical rep, district manager or regional manager at all,
 * because none of them is in Marketing. For them, and in Employee 360 only, a FIELD-FORCE subject on
 * their line(s) is admitted whatever its department. A non-field person (an office role that shares
 * the line) still needs the same department, so this widens to the field force and nowhere else.
 * The shared `lineScopeIncludesEmployee` stays department-safe for every other module.
 */
const MARKETING_LINE_360_ROLES = new Set<PhoenixRole>([
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
]);

/**
 * How far DOWN the field force each marketing viewer's department waiver reaches: strictly below his
 * own rung on the seat ladder (Product Manager 2, Group Product Manager 3, as SEAT_RANK in
 * src/lib/crm/doctor-coverage-scope.ts ranks them), never level with it and never above it. That is
 * the owner's downward rule (2026-09-04). Without this cut the waiver also admitted the line's
 * National and Regional Sales Managers, whose reports carry their expense and outstation claims
 * (risk review, 2026-10-20). The Marketing Manager is not on the ladder, so he is held to the Group
 * Product Manager's reach, the rung beneath him. A subject is admitted only when EVERY title it
 * carries (job and position) is in the reach, so a mixed record counts at its more senior title,
 * the way buildDownwardCut ranks one.
 */
const MARKETING_LINE_360_FIELD_REACH: ReadonlyMap<PhoenixRole, ReadonlySet<Employee360RoleCategory>> = new Map<
  PhoenixRole,
  ReadonlySet<Employee360RoleCategory>
>([
  ["Product Manager", new Set<Employee360RoleCategory>(["medical-rep"])],
  ["Group Product Manager", new Set<Employee360RoleCategory>(["medical-rep", "district-manager"])],
  ["Marketing Manager", new Set<Employee360RoleCategory>(["medical-rep", "district-manager"])],
]);

function isWithinMarketingFieldReach(role: PhoenixRole, subject: Employee360SubjectRow): boolean {
  const reach = MARKETING_LINE_360_FIELD_REACH.get(role);
  if (!reach) return false;
  const categories = [subject.jobTitle, subject.positionTitle]
    .map((title) => resolveEmployee360RoleCategory(title))
    .filter((category): category is Employee360RoleCategory => category != null);
  return categories.length > 0 && categories.every((category) => reach.has(category));
}

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

  // Per-person exclusion: a listed person is removed from Employee 360 entirely — no viewer may open
  // their report, INCLUDING themselves and the company-wide roles. The list is empty since the owner
  // brought its only entry back (owner, 2026-10-20); the gate stays for the next one. Checked before
  // every other branch (above the system/CEO short-circuit and the self check) so nothing can
  // re-admit them. Because this is the single gate behind the admin index, the admin detail route,
  // the portal self report, the portal detail route AND resolveEmployee360VisibleRows, excluding
  // here removes them from every list and every direct URL at once.
  if (isEmployee360ExcludedSubject(subject.hrId)) return false;

  if (context.scope === "system" || COMPANY_360_ROLES.has(context.role)) return true;

  // Everyone can open their own record (field-force filter decides what renders).
  if (hrIdsMatch(context.hrId, subject.hrId)) return true;

  const role = context.role;

  // Training Manager oversees the coachable pool; Talent Acquisition's Employee 360
  // access is narrowed to the same pool (owner-requested 2026-07-26). Both see every
  // Medical Rep company-wide (+ self above) and nobody else.
  if (MEDICAL_REP_ONLY_360_ROLES.has(role)) {
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

  // District Manager / Manager: their team, at any depth. Owner rule (2026-07-30): every role sees
  // themselves plus everyone reporting to them, so this walks the chain like the RM branch above
  // rather than stopping at direct reports. A no-op on today's org shape (a DSM's reports are all
  // leaf Medical Reps) but it stops silently truncating the moment a DSM gains a sub-manager.
  if (role === "District Manager" || role === "Manager") {
    return isWithinManagerHierarchy({
      employee: employeeSeat,
      byCanonicalHrId: scope.byCanonicalHrId,
      viewerCanonicalHrId: viewerKey,
      canonicalize: canonicalHrIdKey,
    });
  }

  // NSM / PM / GPM / Marketing Manager: their line(s). A line_scope_override (e.g. a
  // Group PM or Marketing Manager spanning multiple lines) replaces the own-single-line
  // rule with its explicit line set. For the NSM it stays department-safe, so an override
  // only ever widens WHICH lines are visible, never which department (mirrors the vacation
  // module's LINE scope; see hierarchy-resolver.ts). For the three Marketing-department roles
  // the department test is waived for a field-force subject BELOW them (owner, 2026-10-20 —
  // MARKETING_LINE_360_ROLES), or they would see no field force at all; the downward reach keeps
  // the line's sales managers, and their expense claims, out of it.
  if (
    role === "National Sales Manager" ||
    role === "Product Manager" ||
    role === "Group Product Manager" ||
    role === "Marketing Manager"
  ) {
    const fieldForceAcrossDepartments =
      MARKETING_LINE_360_ROLES.has(role) && isEmployee360Subject(subject) && isWithinMarketingFieldReach(role, subject);
    if (scope.allowedLineKeys) {
      if (!scope.viewer) return false;
      const subjectLine = String(subject.lineName ?? "").trim().toLowerCase();
      return (
        subjectLine !== "" &&
        scope.allowedLineKeys.has(subjectLine) &&
        (fieldForceAcrossDepartments ||
          sameWorkforceDepartment(
            { departmentId: scope.viewer.departmentId, departmentName: scope.viewer.departmentName },
            { departmentId: subject.departmentId, departmentName: subject.departmentName },
          ))
      );
    }
    if (!scope.viewer) return false;
    if (fieldForceAcrossDepartments) {
      return sameWorkforceLine(
        { lineId: scope.viewer.lineId, lineName: scope.viewer.lineName },
        { lineId: subject.lineId, lineName: subject.lineName },
      );
    }
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
