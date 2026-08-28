import type { EmployeeDirectoryData, EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdsMatch, normalizeHrIdForAccess } from "@/lib/hr-id";
import { isWithinManagerHierarchy, type SeatContinuitySubject } from "@/lib/workforce/hierarchy-resolver";
import { isMissingRequiredManager } from "@/lib/employees/hierarchy-governance";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hrBundleGrants } from "@/lib/auth/hr-functions";

export const phoenixRoles = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Training Manager",
  "Marketing Manager",
  "Finance Manager",
  "Financial Advisor",
  // HR seats are BUNDLES OF FUNCTIONS, not job titles — see src/lib/auth/hr-functions.ts.
  // "HR Specialist" (retired 2026-06) and "Talent Acquisition" (retired here, 2026-08-28) were
  // both job titles used as permission keys, and both had to be renamed across the codebase and
  // an eleven-table migration when the person left. These two names are labels for a set of
  // functions and are read by nothing for intent, so neither can go stale the same way.
  "HR Advisory",
  "HR Operations",
  "Manager",
  "CEO",
  "Super Admin",
] as const;
export type PhoenixRole = (typeof phoenixRoles)[number];

export const phoenixCompanyJobTitles = [
  "District Sales Manager",
  "Medical Representative",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Admin Assist",
  "SFE Manager",
  "QPPV",
  "Buffet",
  "Training Manager",
  "Marketing Manager",
  "Office Co-ordinator",
  "Regulatory Affairs",
  "Talent Acquisition",
  // The two HR seats opening 2026-09-01. These are JOB TITLES and belong here; the ACCESS
  // they carry is "HR Advisory" / "HR Operations" in phoenixRoles above, which is a different
  // list on purpose. Office Co-ordinator and Talent Acquisition stay listed because employee
  // records, offers and candidate applications still name them historically.
  "HR Business Partner",
  "HR Operations Coordinator",
  "Finance Manager",
  "CEO",
  "HR Manager",
  "R&D Manager",
  "Research and Development Manager",
  "Financial Advisor",
] as const;
export type PhoenixCompanyJobTitle = (typeof phoenixCompanyJobTitles)[number];

export type PermissionAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "approve"
  | "export"
  | "import";

export type PermissionResource =
  | "employees"
  | "employee_profile"
  | "employee_documents"
  | "team"
  | "overview"
  | "admin_access"
  | "system_cleanup"
  | "imports"
  | "sales"
  | "weekly_sales"
  | "direct_orders"
  | "payroll"
  | "payslips"
  | "deductions"
  | "double_visit_analytics"
  | "weekly_plans"
  | "expenses"
  | "vacancies"
  | "organogram"
  | "offers"
  | "probation"
  | "resignations"
  | "contracts"
  | "coaching"
  | "communication"
  | "hr_calendar"
  | "outstation"
  | "leave"
  | "admin"
  | "user_admin"
  | "permission_admin"
  | "module_control"
  | "support_requests"
  | "recruitment"
  | "candidates"
  | "account_activation"
  | "hiring_interviews"
  | "workflow_registry"
  | "report_it"
  | "attendance"
  | "crm_visits"
  | "early_birds"
  | "user_activity"
  | "synthetic_journeys";

export const permissionResources: PermissionResource[] = [
  "admin",
  "overview",
  "admin_access",
  "system_cleanup",
  "imports",
  "sales",
  "weekly_sales",
  "direct_orders",
  "payroll",
  "deductions",
  "double_visit_analytics",
  "weekly_plans",
  "expenses",
  "employees",
  "team",
  "offers",
  "probation",
  "resignations",
  "contracts",
  "coaching",
  "communication",
  "user_admin",
  "permission_admin",
  "module_control",
  "workflow_registry",
  "employee_documents",
  "employee_profile",
  "vacancies",
  "organogram",
  "hr_calendar",
  "payslips",
  "outstation",
  "leave",
  "support_requests",
  "recruitment",
  "candidates",
  "account_activation",
  "hiring_interviews",
  "report_it",
  "attendance",
  "crm_visits",
  // MUST live in this runtime array, not only in the union above. The sidebar's permission lookup
  // FAILS OPEN on a key it has never seen, so omitting it here would show the Early Birds tab to
  // every role — Finance Manager, HR Operations, Employee — silently and with no test failure.
  "early_birds",
  "user_activity",
  "synthetic_journeys",
];

export const permissionActions: PermissionAction[] = [
  "read",
  "create",
  "update",
  "delete",
  "approve",
  "export",
  "import",
];

export type AccessScope = "self" | "team" | "hierarchy" | "line" | "company" | "none" | "system";
export type BusinessScope = "SELF" | "TEAM" | "HIERARCHY" | "LINE" | "COMPANY" | "NONE";
export type NavigationMode = "admin" | "employee-portal";

export type AccessContext = {
  hrId: string | null;
  loginId?: string | null;
  role: PhoenixRole;
  scope: AccessScope;
  source: "session" | "system" | "dev-header" | "guest";
};

export type PermissionMap = Record<PhoenixRole, Partial<Record<PermissionResource, PermissionAction[]>>>;
type PermissionDbOverrideRow = {
  role_name: string | null;
  resource: string | null;
  action: string | null;
  is_allowed: boolean | null;
};

const allActions: PermissionAction[] = ["read", "create", "update", "delete", "approve", "export", "import"];
// Governance: approval authority is reserved for Super Admin / HR Manager.
// The HR bundles operate recruitment and personnel workflows but must not inherit the retired
// broad HR/payroll/leave/outstation authority — see HR_ROLE_BOUNDARIES in hr-functions.ts.
const portalNavigationRoles = new Set<PhoenixRole>([
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Training Manager",
  "CEO",
  "Manager",
]);

export const adminShellEmployeeRoles = [
  "SFE Manager",
  "Finance Manager",
  "Financial Advisor",
  // Owner decision 2026-08-28: both new HR seats live on the ADMIN shell, not the employee
  // portal. The portal needs a second copy of every admin tool, and two of those copies shipped
  // unreachable for the seat this replaces.
  "HR Advisory",
  "HR Operations",
] as const satisfies readonly PhoenixRole[];
const adminShellEmployeeRoleSet = new Set<PhoenixRole>(adminShellEmployeeRoles);

export function isAdminShellEmployeeRole(role: PhoenixRole): boolean {
  return adminShellEmployeeRoleSet.has(role);
}

// Every caller pairs this with a resource check — `isHrAuthorityRole(role) && canAccess(role, X, Y)` —
// so listing both HR bundles here is safe and the grant does the discriminating: the recruitment
// and offers pages also demand recruitment:read, which only HR Advisory holds, and vacation
// control also demands leave:update, which only HR Operations holds.
export const hrAuthorityRoles = ["Super Admin", "HR Advisory", "HR Operations"] as const satisfies readonly PhoenixRole[];
const hrAuthorityRoleSet = new Set<PhoenixRole>(hrAuthorityRoles);
const hrSupportStaffActions: PermissionAction[] = ["read", "create", "update", "export"];
const supportRequestSenderActions: PermissionAction[] = ["create"];

export function isHrAuthorityRole(role: PhoenixRole): boolean {
  return hrAuthorityRoleSet.has(role);
}

/**
 * Who may OPEN the personal candidate inbox at /recruitment/candidates.
 *
 * This widens who can reach the screen, never what any of them can see. The page is a per-person
 * inbox rather than the candidate pool: listApplications() scopes to the requisitions the caller is
 * hiring manager for (canSeeApplication in src/lib/recruitment/access.ts), and
 * listCandidatesSentToManager() scopes to the caller's own HR_ID. Whoever opens it sees only the
 * CVs addressed to them — for most roles that is an empty screen, which is the honest answer.
 *
 * Owner request (2026-08-24): the gate read `access.role !== "CEO"`, so the Super Admin account
 * that owns the system was redirected off the one recruitment screen it could not otherwise
 * inspect. Its own named set rather than a widening of hrAuthorityRoles, for the same reason
 * outstationApprovalReviewRoles below is its own — running a hiring round and administering the
 * system are different privileges and must be able to diverge later without one dragging the other.
 */
export const personalCandidateInboxRoles = ["CEO", "Super Admin"] as const satisfies readonly PhoenixRole[];
const personalCandidateInboxRoleSet = new Set<PhoenixRole>(personalCandidateInboxRoles);

export function canOpenPersonalCandidateInbox(
  context: Pick<AccessContext, "role" | "scope">,
): boolean {
  return context.scope === "system" || personalCandidateInboxRoleSet.has(context.role);
}

export const systemAdministratorRoles = ["Super Admin"] as const satisfies readonly PhoenixRole[];
const systemAdministratorRoleSet = new Set<PhoenixRole>(systemAdministratorRoles);

export function canAccessSystemAdministratorWorkspace(context: Pick<AccessContext, "role" | "scope">): boolean {
  return context.scope === "system" || systemAdministratorRoleSet.has(context.role);
}

export function assertSystemAdministratorWorkspaceAccess(
  context: Pick<AccessContext, "role" | "scope">,
  workspace = "system administrator workspace",
) {
  if (!canAccessSystemAdministratorWorkspace(context)) {
    throw new Error(`Forbidden: ${context.role} cannot access ${workspace}.`);
  }
}

/**
 * Who may READ the Company Vacation Report (/admin/vacation-report) — the org-wide register of
 * leave that carries the Source column, i.e. whether a day came from a request the employee
 * submitted through Phoenix or from the field CRM's own vacation marking.
 *
 * Owner request (2026-08-27): the SFE Manager must be able to see, and export, every employee's
 * vacation alongside where each one came from. Deliberately its own named set rather than a
 * widening of systemAdministratorRoles — the same reasoning as outstationApprovalReviewRoles
 * above: reading an org-wide report and administering the system are different privileges and
 * must be able to diverge later without one silently dragging the other along.
 *
 * READING is all this grants. The one write this report can perform — turning an unverified CRM
 * Signal row into a real, balance-deducting vacation request — keeps its own gate below and
 * stays Super Admin only, because the owner's instruction was explicit: he can read, he can
 * export, he cannot add.
 */
export const companyVacationReportReaderRoles = ["Super Admin", "SFE Manager"] as const satisfies readonly PhoenixRole[];
const companyVacationReportReaderRoleSet = new Set<PhoenixRole>(companyVacationReportReaderRoles);

export function canReadCompanyVacationReport(context: Pick<AccessContext, "role" | "scope">): boolean {
  return context.scope === "system" || companyVacationReportReaderRoleSet.has(context.role);
}

export function assertCompanyVacationReportReadAccess(
  context: Pick<AccessContext, "role" | "scope">,
  workspace = "the company vacation report",
) {
  if (!canReadCompanyVacationReport(context)) {
    throw new Error(`Forbidden: ${context.role} cannot access ${workspace}.`);
  }
}

/**
 * Who may turn ONE unverified "CRM Signal" row into a real, approved, balance-deducting vacation
 * request (app/api/vacation/company-report/approve).
 *
 * Deliberately unchanged and deliberately separate from the read helper above — the same split
 * canDecideOutstationExpenseApprovals makes below. Hiding the button in the table is a courtesy;
 * THIS is the boundary, and the approve POST route keeps asserting system-administrator access so
 * an SFE Manager request is refused server-side regardless of what the client renders.
 */
export function canApproveCompanyVacationReportRow(context: Pick<AccessContext, "role" | "scope">): boolean {
  return canAccessSystemAdministratorWorkspace(context);
}

/**
 * Who may READ the outstation expense approvals workspace, including its claim validation.
 *
 * Owner request (2026-08-08): the CEO must see whether a claim is corroborated by CRM evidence.
 * The page was Super Admin only, so he could not open it at all. This is the single, named
 * widening — deliberately its own set rather than a change to systemAdministratorRoles, because
 * reading a validation result and administering the system are different privileges and must be
 * able to diverge later without one silently dragging the other along.
 *
 * The CEO's scope is "company", not "system", so the scope shortcut above cannot admit him by
 * accident; membership of this set is the only thing that does.
 */
export const outstationApprovalReviewRoles = ["Super Admin", "CEO"] as const satisfies readonly PhoenixRole[];
const outstationApprovalReviewRoleSet = new Set<PhoenixRole>(outstationApprovalReviewRoles);

export function canReviewOutstationExpenseApprovals(
  context: Pick<AccessContext, "role" | "scope">,
): boolean {
  return context.scope === "system" || outstationApprovalReviewRoleSet.has(context.role);
}

export function assertOutstationExpenseApprovalReviewAccess(
  context: Pick<AccessContext, "role" | "scope">,
  workspace = "outstation expense approvals",
) {
  if (!canReviewOutstationExpenseApprovals(context)) {
    throw new Error(`Forbidden: ${context.role} cannot access ${workspace}.`);
  }
}

/**
 * Who may DECIDE an outstation expense — approve, reject, adjust the payable amount.
 *
 * Deliberately unchanged and deliberately separate from the read helper above. The CEO can read
 * every validation result and decide nothing; Super Admin remains the only role that moves money.
 * Hiding the buttons in the UI is a courtesy — THIS is the boundary, and the decision POST route
 * keeps asserting system-administrator access so a CEO request is refused server-side regardless
 * of what the client renders.
 */
export function canDecideOutstationExpenseApprovals(
  context: Pick<AccessContext, "role" | "scope">,
): boolean {
  return canAccessSystemAdministratorWorkspace(context);
}

function hardBoundaryAllowedActions(role: PhoenixRole, resource: PermissionResource): PermissionAction[] | null {
  switch (resource) {
    case "admin":
      return role === "Super Admin" ? allActions : [];
    case "admin_access":
    case "permission_admin":
    case "user_admin":
    case "system_cleanup":
    case "user_activity":
      return role === "Super Admin" ? allActions : [];
    case "synthetic_journeys":
      return role === "Super Admin" ? ["read"] : [];
    case "employees":
      if (role === "Super Admin") return allActions;
      // HR Operations maintains personnel records; HR Advisory only reads them for workforce
      // insight. NEITHER may delete: both job descriptions require records that survive an audit,
      // so destruction stays Super Admin. This cap is belt-and-braces over HR_ROLE_BOUNDARIES.
      if (role === "HR Operations") return ["read", "create", "update", "export", "import"];
      if (role === "HR Advisory") return ["read", "export"];
      return [];
    case "module_control":
      return role === "Super Admin" ? allActions : [];
    case "employee_documents":
    case "recruitment":
    case "candidates":
    case "offers":
      return isHrAuthorityRole(role) ? allActions : [];
    case "support_requests":
      return isHrAuthorityRole(role) ? hrSupportStaffActions : supportRequestSenderActions;
    // `hiring_interviews` is deliberately NOT hard-boundary-capped (falls to `default`
    // below) — it is a narrow, purpose-built resource (a hiring manager's own assigned
    // candidate + their own interview only, enforced by service-layer scoping in
    // src/lib/recruitment/hiring-manager-view.ts) and must stay independent of the broad
    // `recruitment`/`candidates`/`offers` HR-authority-only lock above.
    default:
      return null;
  }
}

export function isRolePermissionWithinHardBoundary(
  role: PhoenixRole,
  resource: PermissionResource,
  action: PermissionAction,
): boolean {
  const allowedActions = hardBoundaryAllowedActions(role, resource);
  return !allowedActions || allowedActions.includes(action);
}

/**
 * Minimum permissions that must never be denied via `role_permission_overrides`.
 * These are permissions that the employee portal requires for basic functionality;
 * revoking them via a DB override breaks portal pages with an unrecoverable
 * Forbidden error. The admin Access Control Manager checks this before persisting
 * a deny-override.
 */
export const portalMinimumPermissions: ReadonlyArray<{
  action: PermissionAction;
  resource: PermissionResource;
  roles: readonly PhoenixRole[];
}> = [
  { resource: "probation", action: "read", roles: phoenixRoles },
  { resource: "leave", action: "read", roles: phoenixRoles },
  { resource: "employee_profile", action: "read", roles: phoenixRoles },
  { resource: "payroll", action: "read", roles: phoenixRoles },
  // Payslips portal (/employee-portals/payslips) requires payslips:read for all
  // employee-portal roles that carry it by default. Without this floor, a deny-override
  // in role_permission_overrides can silently break the page with a Forbidden error.
  {
    resource: "payslips",
    action: "read",
    roles: [
      "Employee",
      "Medical Rep",
      "Manager",
      "District Manager",
      "Regional Manager",
      "National Sales Manager",
      "Product Manager",
      "Group Product Manager",
      "Marketing Manager",
      "Training Manager",
      "CEO",
    ],
  },
  // Expense dashboard (/employee-portals/expense-dashboard) requires expenses
  // read for all employee-portal roles. Without this floor, a deny-override in
  // role_permission_overrides can silently break the page with a Forbidden error.
  {
    resource: "expenses",
    action: "read",
    roles: [
      "Employee",
      "Medical Rep",
      "Manager",
      "District Manager",
      "Regional Manager",
      "National Sales Manager",
      "Product Manager",
      "Group Product Manager",
      "Marketing Manager",
      "Training Manager",
      "CEO",
    ],
  },
  // Submit-expense page (/employee-portals/submit-expense) requires outstation:create
  // for all roles that can reach it. Without this floor, a deny-override in
  // role_permission_overrides can silently break the page with a Forbidden error.
  {
    resource: "outstation",
    action: "create",
    roles: [
      "Employee",
      "Manager",
      "District Manager",
      "Regional Manager",
      "National Sales Manager",
      "Product Manager",
      "Group Product Manager",
      "Marketing Manager",
    ],
  },
];

export function isDenialBlockedByMinimumPermission(
  role: PhoenixRole,
  resource: PermissionResource,
  action: PermissionAction,
): boolean {
  return portalMinimumPermissions.some(
    (min) =>
      min.resource === resource &&
      min.action === action &&
      min.roles.includes(role),
  );
}

function applyHardPermissionBoundaries<T extends PermissionMap>(matrix: T): T {
  for (const role of phoenixRoles) {
    for (const resource of permissionResources) {
      const allowedActions = hardBoundaryAllowedActions(role, resource);
      if (!allowedActions) continue;

      if (resource === "support_requests") {
        matrix[role][resource] = [...allowedActions];
        continue;
      }

      const currentActions = matrix[role][resource] ?? [];
      const boundedActions = currentActions.filter((action) => allowedActions.includes(action));
      if (boundedActions.length > 0) {
        matrix[role][resource] = boundedActions;
      } else {
        delete matrix[role][resource];
      }
    }
  }
  return matrix;
}

const defaultPermissionMatrix: PermissionMap = {
  "Super Admin": {
    admin: allActions,
    attendance: allActions,
    // `update` added 2026-08-09 for the Doctor Coverage visit-norms editor
    // (/admin/doctor-coverage-settings). It gates ONLY that policy singleton — the CRM visit
    // mirror itself stays read-only everywhere, since it is a vendor mirror nothing may write.
    crm_visits: ["read", "update"],
    early_birds: ["read", "approve"],
    communication: allActions,
    overview: ["read"],
    admin_access: ["read"],
    system_cleanup: allActions,
    // Bulk login-account/role admin (/api/admin/users/bulk) only. Employee-record bulk
    // import (/api/imports/employees/*) checks the `employees` resource instead, so
    // HR Operations' `employees` grant covers it without touching this key.
    imports: allActions,
    contracts: allActions,
    coaching: allActions,
    employee_documents: allActions,
    employee_profile: allActions,
    employees: allActions,
    expenses: allActions,
    hr_calendar: allActions,
    outstation: allActions,
    leave: allActions,
    organogram: allActions,
    offers: allActions,
    payroll: allActions,
    payslips: allActions,
    deductions: allActions,
    double_visit_analytics: allActions,
    weekly_plans: allActions,
    probation: allActions,
    resignations: allActions,
    permission_admin: allActions,
    module_control: allActions,
    workflow_registry: allActions,
    sales: allActions,
    direct_orders: allActions,
    weekly_sales: allActions,
    support_requests: allActions,
    team: allActions,
    user_admin: allActions,
    vacancies: allActions,
    recruitment: allActions,
    candidates: allActions,
    hiring_interviews: allActions,
    report_it: allActions,
    // Activity Control Center: Super Admin only (read + export). Deliberately
    // omitted from every other role so the employee-monitoring surface stays
    // tightly held. Widen via role_permission_overrides if ever needed.
    user_activity: ["read", "export"],
    synthetic_journeys: ["read"],
  },
  CEO: {
    // Segregation of duties: the CEO account is observational on irreversible HR/finance
    // workflows. It may read/export attendance but not create/update/delete records.
    attendance: ["read", "export"],
    crm_visits: ["read"],
    early_birds: ["read"],
    overview: ["read"],
    imports: ["read"], // Bulk user-admin preview only — see Super Admin's `imports` note above.
    // SoD: read/export only — contract renew/not-renew (can drive termination)
    // belongs to Super Admin/HR. The CEO is observational on contracts.
    contracts: ["read", "export"],
    coaching: ["read"],
    employee_profile: ["read", "update", "export"],
    // NOTE: hard boundary (hardBoundaryAllowedActions → "employees" → Super Admin only) removes
    // these actions at runtime. CEO sees only their own employee record via canSeeEmployee().
    // getEmployeeDirectoryRows() (unfiltered) is used on the command center for headcount only.
    employees: ["read", "export"],
    // SoD: read/export only — expense approval belongs to managers + Finance/Super Admin.
    expenses: ["read", "export"],
    // SoD: read/export only — outstation approval belongs to managers + Super Admin.
    outstation: ["read", "export"],
    // Retained by owner decision: CEO approves leave (and excuses, modeled under leave)
    // for their own direct reports. The decide path binds the actor to the active approval
    // step, so this stays scoped to the CEO's chain and does not over-grant.
    leave: ["read", "approve", "export"],
    // SoD: read/approve/export only — the CEO is the final approver of direct orders but
    // never creates/edits them (the decide path binds the actor to the active CEO step).
    direct_orders: ["read", "approve", "export"],
    organogram: ["read", "export"],
    payroll: ["read", "export"],
    probation: ["read"],
    workflow_registry: ["read"],
    payslips: ["read", "export"],
    // SoD: read/export only — deduction decisions belong to the governance actors.
    deductions: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    // Retained by owner decision: CEO approves weekly plans for their direct reports.
    // The approval path binds the actor to the active approval step via the plan workspace,
    // so this stays scoped to the CEO's chain and does not over-grant company-wide.
    weekly_plans: ["read", "approve", "export"],
    // SoD: read/export only — resignation finalization belongs to Super Admin/HR.
    resignations: ["read", "export"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    support_requests: ["read", "export"],
    team: ["read", "export"],
    vacancies: ["read", "export"],
    recruitment: ["read"],
    candidates: ["read"],
    // NSM/RM/CEO candidate tracking: CEO's own hiring round (District Manager -> HR/RM
    // -> National Sales Manager -> CEO for a District Manager candidate). Deliberately NOT
    // hard-boundary-capped (see hiring-manager-view.ts) so this grant actually takes effect.
    hiring_interviews: ["read", "update"],
    report_it: ["read", "create", "export"],
  },
  // ── The two HR seats, composed from functions ─────────────────────────────────────────────
  // These entries are NOT hand-maintained. Each is the union of the grants carried by the
  // functions its bundle holds (src/lib/auth/hr-functions.ts), where every function traces to a
  // numbered section of the job description the owner supplied on 2026-08-28.
  //
  // To change what a seat can do, move a function key between the bundles in that file — do not
  // add a key here. A grant added here would have no job-description line behind it, which is
  // exactly how the seat this replaces accumulated company-wide employee write access over four
  // months of one-off expansions.
  //
  // What each holds today:
  //   HR Advisory    recruiting · engagement_retention · performance_probation ·
  //                  workforce_insight · hr_governance
  //   HR Operations  people_records · time_attendance · payroll_inputs ·
  //                  performance_probation · hr_governance
  //
  // The two shared functions are deliberate: both job descriptions carry a probation section and
  // a governance section, from different angles. Union of the two bundles = all eight functions.
  "HR Advisory": hrBundleGrants("HR Advisory"),
  "HR Operations": hrBundleGrants("HR Operations"),
  // Finance Manager (Ahmed El Maraghy, B-185 — the only holder): the company's finance execution
  // point. He EXECUTES money movements that others have already approved; he does not approve the
  // spend itself. Retuned 2026-08-10 on owner instruction, when the account was activated for the
  // first time since it was created on 2026-05-02.
  //
  // (The comment that used to sit here described Financial Advisor, whose real block is below.)
  "Finance Manager": {
    // No `update`: it is asserted NOWHERE in the codebase, so it granted nothing — but it would
    // have silently handed him order mutation the day anyone added an
    // assertPermission(access, "direct_orders", "update") to an edit route. `read` is what the
    // sales-month setter checks (setDirectOrderSalesMonth), and `export` covers the report and
    // its share links.
    direct_orders: ["read", "export"],
    attendance: ["read", "export"],
    crm_visits: ["read"],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    // NO `outstation` key at all (owner, 2026-08-10): "exclude him 100% from outstation or
    // expenses". Outstation expense claims are a field-operations module the HR Manager approves
    // and Super Admin administers; he has no duty in it. Removing the key — rather than trimming
    // actions — is what closes /api/admin/outstation/**, the Expense Command Center, the expense
    // queue, manual entry, the historical upload and the dashboards in one move.
    //
    // `expenses` is cut to a bare `read` and is NOT an expense grant any more. It survives for one
    // reason only: `expenses:read` is the permission the WHOLE /api/marketing-requests/** namespace
    // is gated on (see access-registry.ts), including /api/marketing-requests/:id/decision and
    // /finance-evidence — the two routes he uses to execute the terminal `finance_execution` rung
    // and attach the money-transfer proof. Delete this key and the rung activated on 2026-08-10
    // becomes a dead end nobody can clear. It buys him nothing on the expense side: getExpensesScope
    // now returns SELF for this role, every outstation page/nav/hub row is gone, and `approve` (the
    // action outstation actually gates its writes on) was never held.
    //
    // If the marketing routes are ever re-gated onto a marketing-specific resource, this key should
    // be deleted outright — it exists only to bridge that collision.
    expenses: ["read"],
    // `approve` added 2026-08-10 (owner): he is the direct manager of three head-office staff
    // (OF-0001, A-1, A-4) and their vacations route to him. This is only the COARSE gate — both
    // decide paths still bind the actor to an assigned pending approval step
    // (getPendingVacationApprovalStepForActor), so a company-scoped role cannot decide anyone
    // else's leave. The Workflow Registry `leave_requests` module is a SECOND, fail-closed gate
    // and must name this role too, or the decision 403s after passing this one.
    //
    // `create` added 2026-08-10 — a BUG FIX, not a widening. The "Request Vacation" row under My
    // Requests is shown to every adminShellEmployeeRole, but its page guard
    // (requireAdminShellEmployeeWorkspaceAccess with action "create") is a PERMISSION check, and
    // he was the only one of the four without the grant. Pressing his own Request Vacation row
    // silently redirected him to /admin/outstation/expense-command — and an admin-shell role has
    // no employee portal, so he had no way to file leave anywhere on the system. SFE Manager,
    // Financial Advisor and the HR bundles all already hold it.
    //
    // Scope is exactly self-service: getVacationRequestPageData, createVacationRequest,
    // resubmitVacationRequest, and the attachment upload URL. It cannot reach company vacation
    // administration — canManageVacationRecords additionally requires leave:DELETE (which he does
    // not hold) plus isAllVacationVisibility, and assertVacationAdminManagement re-checks that
    // same visibility — so `create` on its own moves nothing there.
    leave: ["read", "create", "export", "update", "approve"],
    // Read + export ONLY (owner, 2026-08-10) — deliberately NOT allActions. He keeps everything
    // finance actually needs: the payroll page (with getPayrollScope === COMPANY), the BANK
    // TRANSFER FILE and the statutory summary (both gated on `export`), and the Automated Payroll
    // finance/CIB/FAB sheets (those gate on isAutomatedPayrollFinanceActor, an allow-list
    // independent of this matrix). What he loses is destructive: deleting a salary batch,
    // uploading/replacing payroll, and driving the payroll workflow. `read` must stay — it is a
    // portalMinimumPermissions floor, and payroll_workflow_alert re-checks it per recipient.
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    deductions: ["read", "export"],
    weekly_plans: ["read", "export"],
    // RESTORED 2026-08-10 (owner), together with the `case "Finance Manager": return "COMPANY"` arm
    // in getSalesScope below. **These two must never be separated.** The grant was removed earlier
    // the same day because it passed this permission gate while getSalesScope fell through to NONE:
    // every Source-of-Sales query returned zero rows and the page showed an empty table with no
    // explanation. The grant is not the fix — the grant PLUS the scope arm is.
    //
    // COMPANY specifically, not a narrower scope: his employees.line_name is "Office", which
    // bridgeEmployeeLineToOfficial maps to "Head Office" (sales/official-lines.ts), and every line
    // filter drops Head Office. At any scope below COMPANY his available-line list resolves EMPTY
    // and the Monthly Closing export 403s on every line.
    //
    // NO `import`. That single action is the upload/publish workspace's key — it gates
    // /sales/monthly-closing, /sales/upload, /sales/mapping-database and eight more, plus the
    // "Monthly Closing" hub card. He CONSUMES the closing; he does not produce or publish it.
    //
    // Restricted products stay hidden: canViewRestrictedProducts is CEO + Super Admin only and is
    // untouched. That costs him nothing on the closing — every LA003/LA004/SS001 row sits on the
    // Head Office line, which listMonthlyClosingLines excludes for EVERYONE including the CEO, so
    // his workbook matches the CEO's exactly. It does bite on Source of Sales, where Head Office is
    // ~80% of company value; sos-dashboard-impl.tsx labels that on the figure itself.
    sales: ["read", "export"],
    // Organogram (owner, 2026-08-10). The grant alone is NOT sufficient and never was: the page has
    // TWO gates, and canAccessCompanyOrganogram in src/lib/reports/organogram.ts is the second one.
    // He is named there explicitly, and in canAccessHeadOffice — he is head-office staff, so without
    // the latter his own department is invisible in the very view he was granted.
    organogram: ["read"],
    // Resignations — READ ONLY (owner, 2026-08-10). Company-wide with no scope work needed:
    // isCompanyResignationReader (src/lib/resignations/service.ts) already short-circuits on
    // access.scope === "company", which this role has.
    //
    // Deliberately NOT create/update/approve. Acting on a resignation needs two further levers he
    // does not have and is not getting: a Workflow Registry row (a DB edit; the module is
    // fail-closed and currently lists Super Admin / CEO / the HR bundles), and a company-scope
    // branch in canSeeEmployee — which has none, so today he can only act on his own record.
    resignations: ["read"],
    support_requests: ["read", "create"],
    workflow_registry: ["read"],
    report_it: ["read", "create", "export"],
  },
  // New role: executes the Finance step of marketing requests from the /workspace admin shell.
  // Deliberately narrow — marketing-finance participation (granted via the marketing service
  // role-sets, not a permission resource) + own self-service only; NO HR/payroll/employee authority.
  "Financial Advisor": {
    attendance: ["read"],
    crm_visits: ["read"],
    overview: [],
    employee_profile: ["read", "update"],
    leave: ["read", "create"],
    payslips: ["read", "export"],
    support_requests: ["create"],
    report_it: ["read", "create"],
  },
  Employee: {
    attendance: ["read"],
    crm_visits: ["read"],
    overview: [],
    coaching: ["read"],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    probation: ["read"],
    sales: ["read", "export"],
    support_requests: ["read", "create"],
    report_it: ["read", "create"],
  },
  "Medical Rep": {
    attendance: ["read"],
    crm_visits: ["read"],
    early_birds: ["read"],
    overview: [],
    coaching: ["read"],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
    payroll: ["read", "export"],
    probation: ["read"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    payslips: ["read", "export"],
    support_requests: ["read", "create"],
    report_it: ["read", "create"],
  },
  "District Manager": {
    direct_orders: ["read", "create", "update", "approve", "export"],
    attendance: ["read", "create", "update", "delete", "export"],
    crm_visits: ["read"],
    early_birds: ["read", "approve"],
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create", "export"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    organogram: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    probation: ["read", "export"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    support_requests: ["read", "create"],
    team: ["read", "export"],
    vacancies: ["read", "export"],
    weekly_plans: ["read", "create", "update", "approve"],
    hiring_interviews: ["read", "update"],
    report_it: ["read", "create"],
  },
  "Regional Manager": {
    direct_orders: ["read", "create", "update", "approve", "export"],
    attendance: ["read", "create", "update", "delete", "export"],
    crm_visits: ["read"],
    early_birds: ["read"],
    overview: [],
    // NO `deductions` grant (owner instruction, 2026-08-06: "everyone can only see his deductions
    // only"). This previously read `["read"]`, declared to match a portal page that widened a
    // Regional Manager to their whole management subtree. That widening is gone —
    // collectPortalDeductionScope is now self-only for every role — so the grant has no remaining
    // justification, and while it stood it also opened the company-wide admin endpoints
    // (/api/admin/deductions/*), whose only check was this same `deductions:read`. That let a
    // read-only role download every employee's deduction amounts for any month.
    // A Regional Manager still sees their OWN deductions: the portal page and its nav entry both
    // gate on `employee_profile`, not on this resource.
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create", "export"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    organogram: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    // `export` added 2026-07-30 alongside canExportProbation (src/lib/probation/service.ts), which
    // is what actually enforces this. Matches District Manager and National Sales Manager, the rungs
    // either side of the RM. Scoped, not company-wide: the export is built from getProbationRows,
    // which filters every employee through canReadProbationEmployee, so an RM downloads exactly the
    // med reps in their own subtree — the same rows the tracker already shows them.
    probation: ["read", "export"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    support_requests: ["read", "create"],
    team: ["read", "export"],
    // Same undeclared-access correction as `deductions` above: getEmployeePortalVacancies already
    // has an explicit Regional Manager branch that bounds open seats to the RM's own line AND the
    // regions inside their management subtree (regionsWithinManagerHierarchy), but the grant was
    // never declared — so the page's canAccess gate refused every RM and that branch was dead code.
    // Read-only + export, matching District Manager (team-scoped) and National Sales Manager
    // (line-scoped); every vacancy WRITE surface stays on `vacancies:create`, which RM does not have.
    vacancies: ["read", "export"],
    weekly_plans: ["read", "create", "update", "approve"],
    hiring_interviews: ["read", "update"],
    report_it: ["read", "create"],
  },
  "National Sales Manager": {
    direct_orders: ["read", "create", "update", "approve", "export"],
    attendance: ["read", "create", "update", "delete", "export"],
    crm_visits: ["read"],
    early_birds: ["read"],
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create", "export"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    probation: ["read", "export"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    support_requests: ["read", "create"],
    team: ["read", "export"],
    organogram: ["read"],
    vacancies: ["read", "export"],
    weekly_plans: ["read", "create", "update"],
    hiring_interviews: ["read", "update"],
    report_it: ["read", "create"],
  },
  "Product Manager": {
    direct_orders: ["read", "create", "update", "export"],
    attendance: ["read"],
    // `update` = the Doctor Coverage visit-norms editor only (owner, 2026-08-09: PM, GPM and
    // Marketing Manager set the norms themselves). The CRM visit MIRROR stays read-only for
    // every role — it is a vendor mirror nothing may write. Note the norms are one GLOBAL
    // setting: an edit here changes the coverage rule for all three lines, not just this
    // role's own. Owner accepted that trade-off explicitly when granting it.
    crm_visits: ["read", "update"],
    early_birds: ["read"],
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "approve", "update"],
    coaching: ["read", "create", "update"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    organogram: ["read"],
    vacancies: ["read"],
    probation: ["read"],
    support_requests: ["read", "create"],
    weekly_plans: ["read", "create", "update"],
    hiring_interviews: ["read", "update"],
    report_it: ["read", "create"],
  },
  "Group Product Manager": {
    direct_orders: ["read", "create", "update", "export"],
    attendance: ["read"],
    // `update` = the Doctor Coverage visit-norms editor only (owner, 2026-08-09: PM, GPM and
    // Marketing Manager set the norms themselves). The CRM visit MIRROR stays read-only for
    // every role — it is a vendor mirror nothing may write. Note the norms are one GLOBAL
    // setting: an edit here changes the coverage rule for all three lines, not just this
    // role's own. Owner accepted that trade-off explicitly when granting it.
    crm_visits: ["read", "update"],
    early_birds: ["read"],
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "approve", "update"],
    coaching: ["read", "create", "update"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    organogram: ["read"],
    vacancies: ["read"],
    probation: ["read"],
    support_requests: ["read", "create"],
    weekly_plans: ["read", "create", "update"],
    hiring_interviews: ["read", "update"],
    report_it: ["read", "create"],
  },
  "SFE Manager": {
    // `approve` added 2026-08-02 on owner instruction, alongside the Direct Orders Approvals
    // sidebar entry. This is APPROVAL AUTHORITY over direct orders, not just visibility — the
    // page carries no guard of its own, so showing it without this grant would only produce
    // buttons that 403.
    direct_orders: ["read", "export", "approve"],
    attendance: ["read", "create", "update", "delete", "export"],
    // See the Super Admin note: `update` is the Doctor Coverage visit-norms editor only. SFE
    // Manager owns this module, so he sets the norms. CEO is deliberately NOT granted it —
    // that account stays observational by design.
    crm_visits: ["read", "update"],
    early_birds: ["read"],
    overview: ["read"],
    // Read-only org structure (2026-08-02): needed for /organogram. Grants no write anywhere —
    // seat/vacancy mutations are gated separately.
    organogram: ["read"],
    // Field Workforce Compliance gates on hr_calendar:read. Read-only: it is the working-day
    // calendar the compliance view is computed against, not an HR authoring grant.
    hr_calendar: ["read"],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: allActions,
    coaching: ["read"],
    // SFE Manager submits the (data-driven) SFE probation assessment. probation:read admits them
    // through the coarse route/middleware gate; the fine boundary (canSubmitSfeAssessment) still
    // restricts writes to SFE Manager / probation admin.
    probation: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "import", "export"],
    weekly_sales: allActions,
    support_requests: ["read", "create"],
    weekly_plans: ["read", "create", "update"],
    report_it: ["read", "create"],
  },
  "Training Manager": {
    attendance: ["read"],
    crm_visits: ["read"],
    early_birds: ["read"],
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    // NOTE: the `employees` (employee-master admin) resource is intentionally NOT granted —
    // it is Super-Admin-only at the hard boundary. Training Manager's org-wide directory
    // visibility comes from `team`/`employee_profile` reads + the Training-Manager branch in
    // canSeeEmployee(), not from employee-master admin access.
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read", "create", "update"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    probation: ["read", "export"],
    support_requests: ["read", "create"],
    team: ["read"],
    vacancies: ["read"],
    organogram: ["read"],
    weekly_plans: ["read", "create", "update"],
    report_it: ["read", "create"],
  },
  // Marketing Manager uses the employee portal like PM/GPM for reports and sidebar modules,
  // while HR authority remains blocked.
  "Marketing Manager": {
    attendance: ["read"],
    // `update` = the Doctor Coverage visit-norms editor only (owner, 2026-08-09: PM, GPM and
    // Marketing Manager set the norms themselves). The CRM visit MIRROR stays read-only for
    // every role — it is a vendor mirror nothing may write. Note the norms are one GLOBAL
    // setting: an edit here changes the coverage rule for all three lines, not just this
    // role's own. Owner accepted that trade-off explicitly when granting it.
    crm_visits: ["read", "update"],
    early_birds: ["read"],
    overview: [],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "approve", "update"],
    coaching: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    organogram: ["read"],
    vacancies: ["read"],
    probation: ["read"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    support_requests: ["create"],
    weekly_plans: ["read", "create", "update"],
    hiring_interviews: ["read", "update"],
    report_it: ["read", "create"],
  },
  Manager: {
    attendance: ["read", "create", "update", "delete", "export"],
    crm_visits: ["read"],
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    employees: ["read", "export"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    probation: ["read"],
    sales: ["read", "export"],
    support_requests: ["read", "create"],
    team: ["read", "export"],
    weekly_plans: ["read", "approve"],
    hiring_interviews: ["read", "update"],
    report_it: ["read", "create"],
  },
};

export const permissionMatrix: PermissionMap = applyHardPermissionBoundaries(structuredClone(defaultPermissionMatrix));

export const systemAccessContext: AccessContext = {
  hrId: null,
  role: "Super Admin",
  scope: "system",
  source: "system",
};

function tryParseRole(value: string | null | undefined): PhoenixRole | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const normalized = raw.toLowerCase();
  // GOVERNANCE: this parses an *explicit app role* string (the stored
  // app_auth_users.role, an admin-assigned role, or a workflow allowedRole) plus
  // a few legacy role codes/aliases. It is NOT a job-title interpreter:
  // descriptive job titles — "HR Manager", "Talent Acquisition", "R&D Manager",
  // "Medical Representative", "District Sales Manager", "Regional Sales Manager" —
  // are deliberately absent so a title can never be silently turned into a
  // (privileged) role here. Provisioning never derives a role from a title (see
  // resolveEmployeeAccessRole, which always returns "Employee"); real roles are
  // assigned explicitly. Job-function classification for non-security business
  // rules (outstation allowance tiers, employee-portal / coaching routing) lives
  // in resolveJobFunctionRole (src/lib/employees/job-function.ts), NOT here.
  const legacy: Record<string, PhoenixRole> = {
    "admin assist": "Employee",
    "admin assistant": "Employee",
    buffet: "Employee",
    "account admin": "Super Admin",
    admin: "Super Admin",
    employee: "Employee",
    nsm: "National Sales Manager",
    "office co-ordinator": "Employee",
    "office coordinator": "Employee",
    qppv: "Employee",
    "regulatory affairs": "Employee",
    "employee medical rep": "Medical Rep",
    "medical rep": "Medical Rep",
    "district manager": "District Manager",
    "regional manager": "Regional Manager",
    "national sales manager": "National Sales Manager",
    "product manager": "Product Manager",
    "group product manager": "Group Product Manager",
    "sfe manager": "SFE Manager",
    "training manager": "Training Manager",
    "marketing manager": "Marketing Manager",
    "finance manager": "Finance Manager",
    // Both retired HR seats fail CLOSED, and that is the point rather than an oversight.
    // "HR Specialist" was retired 2026-06 and demoted here; "Talent Acquisition" is retired
    // 2026-08-28 and gets identical treatment. Aliasing a retired seat to its SUCCESSOR looks
    // like continuity and is really a privilege carry-forward: verified in production
    // 2026-08-28, the only row still carrying "Talent Acquisition" is A-16, is_active=false,
    // employment_status=resigned. Pointing that string at HR Advisory would hand a departed
    // employee's stored role — or a token minted before the migration — the full recruiting
    // grant. The two new hires are provisioned with their role written explicitly, so nobody
    // who should have access ever reaches this table.
    "hr specialist": "Employee",
    "talent acquisition": "Employee",
    manager: "Manager",
    ceo: "CEO",
    "super admin": "Super Admin",
  };
  if (legacy[normalized]) return legacy[normalized];

  const normalizedNoPunctuation = normalized.replace(/[^a-z0-9 ]/g, "");
  const legacyNoPunctuation: Record<string, PhoenixRole> = {
    accountadmin: "Super Admin",
    adminassist: "Employee",
    adminassistant: "Employee",
    buffet: "Employee",
    nsm: "National Sales Manager",
    "office coordinator": "Employee",
    qppv: "Employee",
    regulatoryaffairs: "Employee",
    employee: "Employee",
    medicalrep: "Medical Rep",
    districtmanager: "District Manager",
    regionalmanager: "Regional Manager",
    nationalsalesmanager: "National Sales Manager",
    productmanager: "Product Manager",
    groupproductmanager: "Group Product Manager",
    sfemanager: "SFE Manager",
    trainingmanager: "Training Manager",
    marketingmanager: "Marketing Manager",
    financemanager: "Finance Manager",
    hrspecialist: "Employee",
    talentacquisition: "Employee",
    ceo: "CEO",
    superadmin: "Super Admin",
  };
  if (legacyNoPunctuation[normalizedNoPunctuation]) return legacyNoPunctuation[normalizedNoPunctuation];

  const matched = phoenixRoles.find((role) => role.toLowerCase() === normalized);
  return matched ?? null;
}

export function normalizeRole(value: string | null | undefined): PhoenixRole {
  return tryParseRole(value) ?? "Employee";
}

export function parseRoleStrict(value: string | null | undefined): PhoenixRole {
  const parsed = tryParseRole(value);
  if (!parsed) {
    throw new Error(`Invalid role "${String(value ?? "").trim()}".`);
  }
  return parsed;
}

export function isNationalSalesManager(value: string | null | undefined): boolean {
  return normalizeRole(value) === "National Sales Manager";
}

export function isMedicalRep(value: string | null | undefined): boolean {
  return normalizeRole(value) === "Medical Rep";
}

export function getRolePrivilegeRank(role: PhoenixRole) {
  switch (role) {
    case "Super Admin":
      return 400;
    case "CEO":
      return 300;
    case "HR Advisory":
    case "HR Operations":
      return 150;
    case "Finance Manager":
      return 200;
    default:
      return 100;
  }
}

export function normalizeHrId(value: string | null | undefined) {
  return canonicalHrIdKey(value);
}

// Client-safe (no server deps) — defined in hr-id.ts and re-exported here so
// existing server-side importers of this module keep working unchanged.
export { hrIdsMatch, normalizeHrIdForAccess };

export function resolveEmployeeIdentityId(context: Partial<Pick<AccessContext, "hrId" | "loginId">> | null | undefined) {
  if (!context) return null;
  return normalizeHrId(context.hrId) ?? normalizeHrId(context.loginId);
}

export function resolveNavigationMode(context: AccessContext): NavigationMode {
  if (context.source === "guest" || context.scope === "none") {
    return "employee-portal";
  }
  // The CEO is an executive Admin account: it uses the existing admin shell and
  // navigation (landing on /admin/sales-command), never the employee portal.
  if (context.role === "CEO") {
    return "admin";
  }
  return portalNavigationRoles.has(context.role) ? "employee-portal" : "admin";
}

export function canManageCoachingReports(context: Pick<AccessContext, "role" | "scope">) {
  // Marketing Manager is intentionally excluded: the permission matrix grants it coaching:["read"]
  // only (oversight analytics), with no create/update. It previously appeared here, over-granting
  // coaching-lifecycle WRITE authority that bypassed the matrix. Read/oversight stays broad via
  // coachingOversightRoles in src/lib/coaching/service.ts.
  return (
    context.scope === "system" ||
    context.role === "Super Admin" ||
    context.role === "Training Manager" ||
    context.role === "Product Manager" ||
    context.role === "Group Product Manager"
  );
}

export function scopeForRole(role: PhoenixRole): AccessScope {
  if (
    role === "Super Admin" ||
    role === "CEO" ||
    role === "Finance Manager"
  ) {
    return "company";
  }
  if (role === "District Manager" || role === "Manager") return "team";
  if (role === "Regional Manager") return "hierarchy";
  if (
    role === "National Sales Manager" ||
    role === "Product Manager" ||
    role === "Group Product Manager" ||
    role === "Marketing Manager"
  ) {
    return "line";
  }
  return "self";
}

export function createAccessContext(input: {
  hrId?: string | null;
  loginId?: string | null;
  role?: string | null;
  source?: AccessContext["source"];
}): AccessContext {
  const role = normalizeRole(input.role);
  const hrId = normalizeHrId(input.hrId);
  const source = input.source ?? "session";

  return {
    hrId,
    loginId: input.loginId ?? null,
    role,
    scope: source === "guest" ? "none" : scopeForRole(role),
    source,
  };
}

type PermissionMatrix = typeof defaultPermissionMatrix;

type PermissionCacheState = {
  fetchedAt: number;
  matrix: PermissionMatrix;
};

const permissionCacheSeconds = Number(process.env.PHOENIX_PERMISSION_MATRIX_CACHE_SECONDS ?? 30);
const permissionCacheMs = Math.max(5000, Number.isFinite(permissionCacheSeconds) ? permissionCacheSeconds * 1000 : 30000);
let permissionCache: PermissionCacheState | null = null;
let permissionMatrixPromise: Promise<PermissionMatrix> | null = null;

function clonePermissionMatrix(matrix: PermissionMatrix): PermissionMatrix {
  return JSON.parse(JSON.stringify(matrix)) as PermissionMatrix;
}

function normalizePermissionResource(value: string | null | undefined): PermissionResource | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "admin") {
    return "admin_access";
  }
  const found = permissionResources.find((resource) => resource.toLowerCase() === normalized);
  return found ?? null;
}

function normalizePermissionAction(value: string | null | undefined): PermissionAction | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  const found = permissionActions.find((action) => action === normalized);
  return found ? (normalized as PermissionAction) : null;
}

export function parsePermissionResourceStrict(value: string | null | undefined): PermissionResource {
  const resource = normalizePermissionResource(value);
  if (!resource) {
    throw new Error(`Invalid permission resource "${String(value ?? "").trim()}".`);
  }
  return resource;
}

export function parsePermissionActionStrict(value: string | null | undefined): PermissionAction {
  const action = normalizePermissionAction(value);
  if (!action) {
    throw new Error(`Invalid permission action "${String(value ?? "").trim()}".`);
  }
  return action;
}

function toPermissionMatrix(overrides: PermissionDbOverrideRow[]): PermissionMatrix {
  const merged = clonePermissionMatrix(defaultPermissionMatrix);

  overrides.forEach((override) => {
    const role = normalizeRole(override.role_name);
    const resource = normalizePermissionResource(override.resource);
    const action = normalizePermissionAction(override.action);
    if (!resource || !action || typeof override.is_allowed !== "boolean") return;

    const current = merged[role][resource] ?? [];
    const withoutAction = current.filter((item) => item !== action);

    merged[role][resource] = override.is_allowed ? [...withoutAction, action] : withoutAction;
  });

  // Re-apply portal minimum permissions after overrides so that a deny-override
  // in the DB can never strip a floor permission required for portal functionality.
  // Only roles that already carry the floor permission in defaultPermissionMatrix
  // are protected here — this must never GRANT a resource to a role that was
  // deliberately never given it (e.g. Financial Advisor has no payroll access).
  for (const min of portalMinimumPermissions) {
    for (const role of min.roles) {
      if (!defaultPermissionMatrix[role][min.resource]?.includes(min.action)) continue;
      const current = merged[role][min.resource] ?? [];
      if (!current.includes(min.action)) {
        merged[role][min.resource] = [...current, min.action];
      }
    }
  }

  return applyHardPermissionBoundaries(merged);
}

async function getPermissionMatrixFromDb(): Promise<PermissionMatrix> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("role_permission_overrides")
    .select("role_name,resource,action,is_allowed");

  // Never swallow a load failure into the default matrix. A silent revert to
  // defaults can re-grant access an admin explicitly revoked (or drop a grant)
  // with no trace. Surface it and let resolvePermissionMatrix fall back to the
  // last-known-good matrix instead of quietly changing the live policy.
  if (error || !data) {
    throw new Error(
      `Failed to load role_permission_overrides: ${error?.message ?? "no rows returned"}`,
    );
  }

  return toPermissionMatrix(data as PermissionDbOverrideRow[]);
}

async function resolvePermissionMatrix(): Promise<PermissionMatrix> {
  if (permissionCache && permissionCache.fetchedAt + permissionCacheMs > Date.now()) {
    return permissionCache.matrix;
  }

  if (!permissionMatrixPromise) {
    permissionMatrixPromise = getPermissionMatrixFromDb()
      .then((matrix) => {
        permissionCache = { fetchedAt: Date.now(), matrix };
        return matrix;
      })
      .catch((error) => {
        // Fail observable, not silent. Retain the last-known-good matrix so a
        // transient DB error can't quietly widen access; only a cold start with
        // no prior matrix falls back to the built-in defaults. We intentionally
        // do not cache this degraded result, so the next call retries the DB.
        logError("role_permission_overrides load failed; retaining last-known matrix", { labels: { event: "permission_matrix_load_failed" }, error });
        return permissionCache?.matrix ?? applyHardPermissionBoundaries(clonePermissionMatrix(defaultPermissionMatrix));
      })
      .finally(() => {
        permissionMatrixPromise = null;
      });
  }

  return permissionMatrixPromise;
}

export function clearPermissionMatrixCache() {
  permissionCache = null;
}

export async function getPermissionMatrix(): Promise<PermissionMatrix> {
  return resolvePermissionMatrix();
}

export async function canAccess(
  context: AccessContext,
  resource: PermissionResource,
  action: PermissionAction = "read",
) {
  if (context.scope === "system") return true;
  if (context.source === "guest" || context.scope === "none") return false;
  const matrix = await resolvePermissionMatrix();
  return matrix[context.role][resource]?.includes(action) ?? false;
}

export function getSalesScope(context: Pick<AccessContext, "role"> & { salesScopeOverride?: BusinessScope | null }): BusinessScope {
  if (context.salesScopeOverride) return context.salesScopeOverride;
  switch (context.role) {
    case "Medical Rep":
    case "Employee":
      return "SELF";
    case "District Manager":
    case "Manager":
      return "TEAM";
    case "Regional Manager":
      return "HIERARCHY";
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "Marketing Manager":
      return "LINE";
    case "SFE Manager":
    case "CEO":
    case "Super Admin":
    // Finance Manager added 2026-08-10 (owner) as the second half of the restored `sales` grant
    // above — see the long note on that key. This arm is not optional garnish: the grant WITHOUT it
    // is precisely the bug that got the grant removed earlier the same day, because a role that
    // falls to the NONE default below gets fail-closed EMPTY line/region/area sets, and every
    // consumer reads an empty set as "no rows" rather than "no access". The page then renders a
    // confident empty table.
    //
    // It must be COMPANY rather than LINE: his employees.line_name is "Office" → "Head Office",
    // which every line filter drops, so any bounded scope resolves his available-line list to empty.
    //
    // Deliberately the switch arm and NOT app_auth_users.sales_scope_override: AccessContext carries
    // no salesScopeOverride field, so every caller passing a bare context takes this switch and
    // would never see a DB value; and the Access Control Manager renders the role's scope from
    // getSalesScope({ role }) with no override, so a DB-only grant would display as NONE while the
    // holder actually had COMPANY. This is role policy, not per-person data.
    case "Finance Manager":
      // Company-wide commercial oversight. Restricted products stay hidden unless the role
      // is explicitly allowed by canViewRestrictedProducts.
      return "COMPANY";
    default:
      return "NONE";
  }
}

export function getPayrollScope(context: Pick<AccessContext, "role">): BusinessScope {
  if (
    context.role === "CEO" ||
    context.role === "Finance Manager" ||
    context.role === "Super Admin"
  ) {
    return "COMPANY";
  }

  return "SELF";
}

export function getExpensesScope(
  context: Pick<AccessContext, "role"> & { expensesScopeOverride?: BusinessScope | null },
) {
  if (context.expensesScopeOverride) return context.expensesScopeOverride;

  switch (context.role) {
    case "District Manager":
    case "Manager":
      return "TEAM";
    case "Regional Manager":
      return "HIERARCHY";
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "Training Manager":
    case "Marketing Manager":
      return "LINE";
    case "SFE Manager":
    case "CEO":
    // Finance Manager removed 2026-08-10 (owner: "exclude him 100% from outstation or expenses").
    // He falls to SELF, and as head-office staff he files no outstation claims, so his expense
    // visibility is empty rather than company-wide. This is the scope half of the removal: the
    // `outstation` key is gone from his matrix, but resolveExpenseAccessFilter in
    // src/lib/outstation/expenses.ts reads getExpensesScope off the residual `expenses:read` he
    // keeps for the marketing routes — leaving him COMPANY here would have handed back exactly the
    // company-wide expense read the key removal was meant to close.
    case "Super Admin":
      return "COMPANY";
    default:
      return "SELF";
  }
}

export function canAccessPayroll(
  context: AccessContext,
  target: { employeeHrId?: string | null; hrId?: string | null; managerHrId?: string | null },
) {
  if (context.source === "guest" || context.scope === "none") return false;
  if (context.scope === "system" || getPayrollScope(context) === "COMPANY") return true;
  return hrIdsMatch(context.hrId, target.employeeHrId ?? target.hrId);
}

export function canAccessSales(
  context: AccessContext,
  record: { employeeHrId?: string | null; hrId?: string | null; managerHrId?: string | null; line?: string | null },
  viewer?: { line?: string | null },
) {
  if (context.source === "guest" || context.scope === "none") return false;
  const scope = context.scope === "system" ? "COMPANY" : getSalesScope(context);
  if (scope === "COMPANY") return true;
  if (scope === "NONE") return false;
  if (!context.hrId) return false;
  if (scope === "SELF") return hrIdsMatch(context.hrId, record.employeeHrId ?? record.hrId);
  if (scope === "TEAM") return hrIdsMatch(context.hrId, record.managerHrId);
  if (scope === "LINE") return normalizeLineName(record.line) === normalizeLineName(viewer?.line);
  return false;
}

export function normalizeLineName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

export async function canReadEmployeeDirectory(context: AccessContext) {
  return (
    (await canAccess(context, "employees", "read")) ||
    (await canAccess(context, "team", "read")) ||
    (await canAccess(context, "employee_profile", "read"))
  );
}

export function isDirectReport(
  managerHrId: string | null,
  employee: Pick<EmployeeDirectoryRow, "managerHrId"> & { pendingManagerReplacementForHrId?: string | null },
) {
  return (
    hrIdsMatch(managerHrId, employee.managerHrId) ||
    // Seat continuity: a report whose manager seat is mid-replacement carries the marker; the
    // stand-in must keep seeing them (mirrors reportsToManagerSeat in the hierarchy resolver).
    hrIdsMatch(managerHrId, employee.pendingManagerReplacementForHrId ?? null)
  );
}

function canSeeDirectReportsByRole(role: PhoenixRole) {
  return (
    role === "District Manager" ||
    role === "Manager" ||
    role === "Regional Manager" ||
    role === "National Sales Manager"
  );
}

export function canSeeEmployee(
  context: AccessContext,
  employee: Pick<EmployeeDirectoryRow, "hrId" | "managerHrId"> & { pendingManagerReplacementForHrId?: string | null },
  options?: { byCanonicalHrId?: Map<string, SeatContinuitySubject> },
) {
  if (context.source === "guest" || context.scope === "none") return false;
  if (context.scope === "system" || context.role === "Super Admin") return true;

  // Training Manager has org-wide training oversight: they coach and assess employees across
  // every line, so the employee directory (and any canSeeEmployee-gated training surface) shows
  // the whole company. Sensitive financial domains stay self-scoped because getPayrollScope /
  // getExpensesScope key off role, not this helper, so org-wide oversight never exposes salaries.
  if (context.role === "Training Manager") return true;

  // Both HR bundles have company-wide people oversight — HR Advisory to advise on the workforce
  // (workforce_insight), HR Operations to maintain its records (people_records). Same carve-out
  // shape as Training Manager above, for the same reason: sensitive financial domains stay
  // self-scoped because they key off role, not this helper.
  if (context.role === "HR Advisory" || context.role === "HR Operations") return true;

  const currentHrId = normalizeHrId(context.hrId);
  const employeeHrId = normalizeHrId(employee.hrId);

  if (!currentHrId || !employeeHrId) return false;

  if (hrIdsMatch(currentHrId, employeeHrId)) {
    return true;
  }

  // Regional Manager / NSM manage through intermediate managers, so a single manager hop showed
  // them almost nobody. When the caller can supply the full directory index (list surfaces do),
  // they see their whole reporting subtree via the canonical walker. Single-row callers without
  // an index keep the conservative direct-report behaviour; Medical Rep / Employee are unaffected
  // either way (canSeeDirectReportsByRole stays false for them).
  if (
    options?.byCanonicalHrId &&
    (context.role === "Regional Manager" || context.role === "National Sales Manager")
  ) {
    return isWithinManagerHierarchy({
      employee: {
        managerHrId: employee.managerHrId,
        pendingManagerReplacementForHrId: employee.pendingManagerReplacementForHrId ?? null,
      },
      byCanonicalHrId: options.byCanonicalHrId,
      viewerCanonicalHrId: canonicalHrIdKey(currentHrId) || "",
      canonicalize: (value) => canonicalHrIdKey(value) || null,
    });
  }

  return canSeeDirectReportsByRole(context.role) && isDirectReport(currentHrId, employee);
}

export function canSeeHrScopedRecord(
  context: AccessContext,
  record: {
    employeeHrId?: string | null;
    hrId?: string | null;
    managerHrId?: string | null;
  },
) {
  if (context.source === "guest" || context.scope === "none") return false;
  if (context.scope === "system" || context.role === "Super Admin") return true;

  const currentHrId = normalizeHrId(context.hrId);
  const employeeHrId = normalizeHrId(record.employeeHrId ?? record.hrId);
  const managerHrId = normalizeHrId(record.managerHrId);

  if (!currentHrId) return false;
  if (context.role === "District Manager" || context.role === "Manager") {
    return hrIdsMatch(currentHrId, employeeHrId) || hrIdsMatch(currentHrId, managerHrId);
  }

  return hrIdsMatch(currentHrId, employeeHrId);
}

export function filterEmployeesForAccess<T extends Pick<EmployeeDirectoryRow, "hrId" | "managerHrId">>(
  rows: T[],
  context: AccessContext,
) {
  // Build the manager index once so RM/NSM resolve their whole subtree, not one hop.
  const byCanonicalHrId = new Map<string, SeatContinuitySubject>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hrId);
    if (!key) continue;
    byCanonicalHrId.set(key, {
      managerHrId: row.managerHrId,
      pendingManagerReplacementForHrId:
        (row as { pendingManagerReplacementForHrId?: string | null }).pendingManagerReplacementForHrId ?? null,
    });
  }
  return rows.filter((row) => canSeeEmployee(context, row, { byCanonicalHrId }));
}

// Owner-requested (2026-07-25, carried to both HR bundles): an HR seat browses the whole employee
// directory (see hardBoundaryAllowedActions above), but must not see the real
// salary figures for this specific set of senior employees — her own manager
// chain (B-10 HR Manager, AA CEO) plus a handful of other named seniors. Row
// visibility is unaffected; only the compensation fields below are blanked.
// See the isSalaryRedactedForViewer check in app/api/employees/route.ts's POST
// handler for the matching write-side guard — without it, a blanked read
// becomes a real, destructive write the moment this viewer edits an unrelated
// field and saves.
const HR_SEAT_SALARY_REDACTED_HR_IDS = new Set(
  ["B-10", "AA", "A-12", "AB", "OF-0002", "B-185", "A-9"].map((id) => normalizeHrId(id)),
);

/** True when `context` must not see (or write) the real salary figures for `hrId`. */
export function isSalaryRedactedForViewer(
  context: Pick<AccessContext, "role">,
  hrId: string | null | undefined,
): boolean {
  if (context.role !== "HR Advisory" && context.role !== "HR Operations") return false;
  return HR_SEAT_SALARY_REDACTED_HR_IDS.has(normalizeHrId(hrId ?? ""));
}

function redactSalaryFields(row: EmployeeDirectoryRow, context: AccessContext): EmployeeDirectoryRow {
  if (!isSalaryRedactedForViewer(context, row.hrId)) return row;
  return {
    ...row,
    baseSalary: null,
    basicSalary: null,
    extraCostOfLiving: null,
    fuelAllowance: null,
    grossSalary: null,
    medicalInsurance: null,
    netSalary: null,
    salaryDetails: null,
    socialInsurance: null,
    socialInsuranceWage: null,
    taxes: null,
  };
}

export function filterEmployeeDirectoryForAccess(
  directory: EmployeeDirectoryData,
  context: AccessContext,
): EmployeeDirectoryData {
  if (context.source === "guest" || context.scope === "none") {
    return {
      ...directory,
      employees: [],
      lookups: {
        ...directory.lookups,
        managers: [],
      },
      summary: {
        activeEmployees: 0,
        employeesWithoutManagers: 0,
        totalEmployees: 0,
        uniqueAreas: 0,
        uniqueLines: 0,
      },
    };
  }
  if (context.scope === "system" || context.role === "Super Admin") return directory;

  const employees = filterEmployeesForAccess(directory.employees, context).map((employee) =>
    redactSalaryFields(employee, context),
  );
  const visibleHrIds = new Set(employees.map((employee) => normalizeHrId(employee.hrId)).filter(Boolean));

  return {
    ...directory,
    employees,
    lookups: {
      ...directory.lookups,
      managers: directory.lookups.managers.filter((manager) => visibleHrIds.has(normalizeHrId(manager.value))),
    },
    summary: {
      activeEmployees: employees.filter((employee) =>
        ["active", "on_leave"].includes(String(employee.employmentStatus ?? "active").toLowerCase()),
      ).length,
      employeesWithoutManagers: employees.filter(isMissingRequiredManager).length,
      totalEmployees: employees.length,
      uniqueAreas: new Set(employees.map((employee) => employee.areaName).filter(Boolean)).size,
      uniqueLines: new Set(employees.map((employee) => employee.lineName).filter(Boolean)).size,
    },
  };
}

export async function assertPermission(
  context: AccessContext,
  resource: PermissionResource,
  action: PermissionAction = "read",
) {
  if (!(await canAccess(context, resource, action))) {
    throw new Error(`Forbidden: ${context.role} cannot ${action} ${resource}.`);
  }
}

export async function canAccessAttendanceSetup(
  context: AccessContext,
  action: Extract<PermissionAction, "read" | "update"> = "read",
) {
  return canAccess(context, "employees", action);
}

export async function assertAttendanceSetupPermission(
  context: AccessContext,
  action: Extract<PermissionAction, "read" | "update"> = "read",
) {
  if (!(await canAccessAttendanceSetup(context, action))) {
    throw new Error(`Forbidden: ${context.role} cannot ${action} attendance setup.`);
  }
}

/**
 * Fingerprint Attendance Report: a page-scoped exception to the "employees"
 * hard boundary (Super Admin only — see hardBoundaryAllowedActions). CEO is
 * explicitly allowed onto this one report/export even though CEO does not
 * otherwise hold employees:read; every other "employees"-gated surface
 * (employee directory, Attendance Setup, etc.) stays Super Admin-only.
 */
export async function canAccessFingerprintReport(context: AccessContext) {
  if (context.role === "CEO") return true;
  return canAccess(context, "employees", "read");
}

export async function assertFingerprintReportPermission(context: AccessContext) {
  if (!(await canAccessFingerprintReport(context))) {
    throw new Error(`Forbidden: ${context.role} cannot read the fingerprint attendance report.`);
  }
}

/**
 * Weekly normalizer mapping-template workbook: a route-scoped CEO exception, same shape as the
 * fingerprint report above.
 *
 * The workbook embeds the UNSCOPED master catalogue — every product code/name/line, every region,
 * every area — including the confidential Head Office line (LA003/LA004/SS001). That catalogue is
 * why the route moved off `weekly_sales:export` (#2234): export reaches down to Medical Rep, so the
 * whole sales field could pull it. But `weekly_sales:update` is held only by Super Admin and SFE
 * Manager, and that swept up the CEO too — who is one of exactly two roles
 * (see HEAD_OFFICE_LINE_KEYS / canViewHeadOffice in src/lib/sales/weekly/access.ts) already cleared
 * to see the Head Office line the workbook's sensitivity rests on.
 *
 * So the CEO is allowed here explicitly rather than by widening `update`, which would also hand him
 * create/delete/approve/import across every other weekly_sales route. Every sibling normalizer route
 * (preview / save / learn / ai-suggest) stays update-only.
 */
export async function canAccessWeeklyMappingTemplate(context: AccessContext) {
  if (context.role === "CEO") return true;
  return canAccess(context, "weekly_sales", "update");
}

export async function assertWeeklyMappingTemplatePermission(context: AccessContext) {
  if (!(await canAccessWeeklyMappingTemplate(context))) {
    throw new Error(`Forbidden: ${context.role} cannot export the weekly mapping template.`);
  }
}

/**
 * Workflow Control Center (Admin / Governance) access design.
 *
 * Phase 1 is a READ-ONLY workflow map + simulator. Access is restricted to HR
 * governance: Super Admin only. HR Manager is a manager title held by a Super
 * Admin account. Both HR bundles are intentionally excluded, as are CEO,
 * Finance Manager, all Sales roles, Training
 * Manager and Employees.
 *
 * If a future non-Super-Admin HR governance user must be granted access, add
 * their (normalized) HR_ID to WORKFLOW_CONTROL_GOVERNANCE_HR_IDS rather than
 * widening the role set.
 *
 * Editing is globally disabled in Phase 1 via WORKFLOW_CONTROL_EDIT_ENABLED.
 * The edit design is reserved for Phase 2 (versioning / draft / publish /
 * rollback) but stays locked while the flag is false.
 */
export const WORKFLOW_CONTROL_ACCESS_ROLES: readonly PhoenixRole[] = ["Super Admin"];

/** Extra non-Super-Admin HR governance accounts (normalized HR_IDs). None today. */
export const WORKFLOW_CONTROL_GOVERNANCE_HR_IDS: readonly string[] = [];

/** Phase 1: workflow editing is disabled for everyone. Flipped on in Phase 2. */
export const WORKFLOW_CONTROL_EDIT_ENABLED = false;

export function canAccessWorkflowControlCenter(context: Pick<AccessContext, "role" | "hrId">): boolean {
  if (WORKFLOW_CONTROL_ACCESS_ROLES.includes(context.role)) return true;
  const normalized = normalizeHrIdForAccess(context.hrId);
  return normalized != null && WORKFLOW_CONTROL_GOVERNANCE_HR_IDS.some((id) => normalizeHrIdForAccess(id) === normalized);
}

export function canEditWorkflowControlCenter(context: Pick<AccessContext, "role" | "hrId">): boolean {
  // Phase 2 design: edit follows the same access set — but stays locked until
  // WORKFLOW_CONTROL_EDIT_ENABLED is turned on.
  if (!WORKFLOW_CONTROL_EDIT_ENABLED) return false;
  return canAccessWorkflowControlCenter(context);
}

/**
 * Phase 2A: a SAFE, client-only Draft Editor (display/config fields, local
 * state, no persistence, no runtime/publish). Available to the same governance
 * set as access (Super Admin only). This is distinct from
 * WORKFLOW_CONTROL_EDIT_ENABLED, which gates REAL runtime editing/publish and
 * remains OFF.
 */
export const WORKFLOW_CONTROL_DRAFT_EDITOR_ENABLED = true;

export function canUseWorkflowDraftEditor(context: Pick<AccessContext, "role" | "hrId">): boolean {
  if (!WORKFLOW_CONTROL_DRAFT_EDITOR_ENABLED) return false;
  return canAccessWorkflowControlCenter(context);
}

/**
 * Activity Control Center (Admin oversight) access design.
 *
 * The control center reports how every user navigates the system (module-level
 * usage + dwell time, drawn from app_sessions and activity_events). Because it
 * is an employee-monitoring surface, access is restricted to Super Admin only.
 * The page also enforces `assertPermission(ctx, "user_activity", action)`; this
 * role gate is a fast, explicit redirect guard that mirrors the matrix.
 *
 * To onboard a non-Super-Admin governance account later, prefer adding a
 * `role_permission_overrides` row (resource `user_activity`) over widening this
 * role list.
 */
export const ACTIVITY_CONTROL_ACCESS_ROLES: readonly PhoenixRole[] = ["Super Admin"];

/**
 * Transparency flag: when true, the employee portal surfaces a short notice that
 * in-app usage is recorded for security/product purposes. Owner chose silent for
 * v1; flip to true to enable the notice with zero further code changes.
 */
export const ACTIVITY_TRACKING_SHOW_EMPLOYEE_NOTICE = false;

export function canAccessActivityControlCenter(context: Pick<AccessContext, "role" | "scope">): boolean {
  if (context.scope === "system") return true;
  return ACTIVITY_CONTROL_ACCESS_ROLES.includes(context.role);
}
