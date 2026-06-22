import type { EmployeeDirectoryData, EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { isMissingRequiredManager } from "@/lib/employees/hierarchy-governance";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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
  "Talent Acquisition",
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
  | "workflow_registry"
  | "report_it"
  | "attendance"
  | "user_activity";

export const permissionResources: PermissionResource[] = [
  "admin",
  "overview",
  "admin_access",
  "system_cleanup",
  "imports",
  "sales",
  "weekly_sales",
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
  "report_it",
  "attendance",
  "user_activity",
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
// Talent Acquisition can operate recruitment workflows but must not inherit the
// retired broad HR/payroll/leave/outstation authority.
const portalNavigationRoles = new Set<PhoenixRole>([
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
  "CEO",
  "Manager",
]);

export const adminShellEmployeeRoles = [
  "SFE Manager",
  "Marketing Manager",
  "Finance Manager",
  "Financial Advisor",
  "Talent Acquisition",
] as const satisfies readonly PhoenixRole[];
const adminShellEmployeeRoleSet = new Set<PhoenixRole>(adminShellEmployeeRoles);

export function isAdminShellEmployeeRole(role: PhoenixRole): boolean {
  return adminShellEmployeeRoleSet.has(role);
}

export const hrAuthorityRoles = ["Super Admin", "Talent Acquisition"] as const satisfies readonly PhoenixRole[];
const hrAuthorityRoleSet = new Set<PhoenixRole>(hrAuthorityRoles);
const hrSupportStaffActions: PermissionAction[] = ["read", "create", "update", "export"];
const supportRequestSenderActions: PermissionAction[] = ["create"];

export function isHrAuthorityRole(role: PhoenixRole): boolean {
  return hrAuthorityRoleSet.has(role);
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

function hardBoundaryAllowedActions(role: PhoenixRole, resource: PermissionResource): PermissionAction[] | null {
  switch (resource) {
    case "employees":
      return role === "Super Admin" ? allActions : [];
    case "module_control":
      return role === "Super Admin" ? allActions : [];
    case "employee_documents":
    case "recruitment":
    case "candidates":
    case "offers":
      return isHrAuthorityRole(role) ? allActions : [];
    case "support_requests":
      return isHrAuthorityRole(role) ? hrSupportStaffActions : supportRequestSenderActions;
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
    communication: allActions,
    overview: ["read"],
    admin_access: ["read"],
    system_cleanup: allActions,
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
    weekly_sales: allActions,
    support_requests: allActions,
    team: allActions,
    user_admin: allActions,
    vacancies: allActions,
    recruitment: allActions,
    candidates: allActions,
    report_it: allActions,
    // Activity Control Center: Super Admin only (read + export). Deliberately
    // omitted from every other role so the employee-monitoring surface stays
    // tightly held. Widen via role_permission_overrides if ever needed.
    user_activity: ["read", "export"],
  },
  CEO: {
    admin: ["read"],
    // Segregation of duties: the CEO account is observational on irreversible HR/finance
    // workflows. It may read/export attendance but not create/update/delete records.
    attendance: ["read", "export"],
    overview: ["read"],
    admin_access: ["read"],
    imports: ["read"],
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
    organogram: ["read", "export"],
    payroll: ["read", "export"],
    permission_admin: ["read"],
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
    user_admin: ["read"],
    vacancies: ["read", "export"],
    recruitment: ["read"],
    candidates: ["read"],
    report_it: ["read", "create", "export"],
  },
  "Talent Acquisition": {
    employee_documents: ["read", "create", "update", "export"],
    employee_profile: ["read", "update"],
    leave: ["read", "update", "export"],
    offers: ["read", "create", "update", "export"],
    vacancies: ["read", "create", "update", "export"],
    recruitment: ["read", "create", "update", "export", "import"],
    candidates: ["read", "create", "update", "delete", "export", "import"],
    support_requests: ["read", "create", "update", "export"],
    report_it: ["read", "create"],
  },
  // Financial Advisor: executes approved requests (payroll runs, disbursements).
  // No approval authority on any resource — does not approve, only processes.
  "Finance Manager": {
    attendance: ["read", "export"],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export", "update"],
    outstation: ["read", "export", "update"],
    leave: ["read", "export", "update"],
    payroll: allActions,
    payslips: ["read", "export"],
    deductions: ["read", "export"],
    weekly_plans: ["read", "export"],
    sales: ["read", "export"],
    support_requests: ["read", "create"],
    workflow_registry: ["read"],
    report_it: ["read", "create", "export"],
  },
  // New role: executes the Finance step of marketing requests from the /workspace admin shell.
  // Deliberately narrow — marketing-finance participation (granted via the marketing service
  // role-sets, not a permission resource) + own self-service only; NO HR/payroll/employee authority.
  "Financial Advisor": {
    attendance: ["read"],
    overview: [],
    employee_profile: ["read", "update"],
    leave: ["read", "create"],
    payslips: ["read", "export"],
    support_requests: ["create"],
    report_it: ["read", "create"],
  },
  Employee: {
    attendance: ["read"],
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
    attendance: ["read", "create", "update", "delete", "export"],
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "approve", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create", "approve", "export"],
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
    recruitment: ["read", "update"],
    report_it: ["read", "create"],
  },
  "Regional Manager": {
    attendance: ["read", "create", "update", "delete", "export"],
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "approve", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create", "approve", "export"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    organogram: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    probation: ["read"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    support_requests: ["read", "create"],
    team: ["read", "export"],
    weekly_plans: ["read", "create", "update", "approve"],
    recruitment: ["read", "update"],
    report_it: ["read", "create"],
  },
  "National Sales Manager": {
    attendance: ["read", "create", "update", "delete", "export"],
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "approve", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create", "approve", "export"],
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
    recruitment: ["read", "update"],
    report_it: ["read", "create"],
  },
  "Product Manager": {
    attendance: ["read"],
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
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
    recruitment: ["read", "update"],
    report_it: ["read", "create"],
  },
  "Group Product Manager": {
    attendance: ["read"],
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
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
    recruitment: ["read", "update"],
    report_it: ["read", "create"],
  },
  "SFE Manager": {
    attendance: ["read", "create", "update", "delete", "export"],
    overview: ["read"],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: allActions,
    coaching: ["read"],
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
    leave: ["read", "create", "export"],
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
  // Marketing Manager = company-wide MARKETING + COMMERCIAL oversight. It owns the Marketing
  // Review approval step and needs full visibility of marketing requests, sales, and ROI. As an
  // EXECUTIVE marketing role it ALSO holds company-wide READ-ONLY oversight of the field/commercial
  // reports that Product/Group-Product/Training Managers see — coaching, double_visit_analytics,
  // organogram, vacancies, probation, team — VIEW ONLY (no coaching write: canManageCoachingReports
  // still excludes it). It holds NO HR authority: employees/employee_documents/offers/recruitment/
  // candidates stay denied by the hard boundary. Only grants that survive the hard boundary are
  // declared here, so this matrix reads as the role's true effective access.
  "Marketing Manager": {
    attendance: ["read"],
    overview: [],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    support_requests: ["create"],
    weekly_plans: ["read", "create", "update", "approve"],
    report_it: ["read", "create"],
    coaching: ["read"],
    double_visit_analytics: ["read", "export"],
    team: ["read"],
    vacancies: ["read"],
    probation: ["read"],
    organogram: ["read"],
  },
  Manager: {
    attendance: ["read", "create", "update", "delete", "export"],
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
    recruitment: ["read", "update"],
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
    "hr specialist": "Employee",
    "talent acquisition": "Talent Acquisition",
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
    talentacquisition: "Talent Acquisition",
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

export function getRolePrivilegeRank(role: PhoenixRole) {
  switch (role) {
    case "Super Admin":
      return 400;
    case "CEO":
      return 300;
    case "Talent Acquisition":
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

export function normalizeHrIdForAccess(value: string | null | undefined) {
  const normalized = normalizeHrId(value);
  return normalized ? normalized.replace(/[^a-z0-9]/g, "") : null;
}

function hrIdsMatch(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizeHrId(left);
  const b = normalizeHrId(right);
  if (a && b && a === b) return true;

  const canonicalLeft = normalizeHrIdForAccess(left);
  const canonicalRight = normalizeHrIdForAccess(right);
  return Boolean(
    canonicalLeft && canonicalRight && canonicalLeft === canonicalRight,
  );
}

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
  if (role === "National Sales Manager" || role === "Product Manager" || role === "Group Product Manager") {
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
        console.error(
          "[permissions] role_permission_overrides load failed; retaining last-known matrix",
          error,
        );
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
      return "LINE";
    case "Marketing Manager":
    case "SFE Manager":
    case "CEO":
    case "Super Admin":
      // Company-wide commercial oversight. Marketing Manager sees all lines for monthly sales
      // and the Marketing ROI dashboard (which scopes via resolveSalesAccessScope); restricted
      // products stay hidden because canViewRestrictedProducts(role) is false for it.
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
      return "LINE";
    case "SFE Manager":
    case "Marketing Manager":
    case "CEO":
    case "Finance Manager":
    case "Marketing Manager":
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

export function isDirectReport(managerHrId: string | null, employee: Pick<EmployeeDirectoryRow, "managerHrId">) {
  return hrIdsMatch(managerHrId, employee.managerHrId);
}

function canSeeDirectReportsByRole(role: PhoenixRole) {
  return (
    role === "District Manager" ||
    role === "Manager" ||
    role === "Regional Manager" ||
    role === "National Sales Manager"
  );
}

export function canSeeEmployee(context: AccessContext, employee: Pick<EmployeeDirectoryRow, "hrId" | "managerHrId">) {
  if (context.source === "guest" || context.scope === "none") return false;
  if (context.scope === "system" || context.role === "Super Admin") return true;

  // Training Manager has org-wide training oversight: they coach and assess employees across
  // every line, so the employee directory (and any canSeeEmployee-gated training surface) shows
  // the whole company. Sensitive financial domains stay self-scoped because getPayrollScope /
  // getExpensesScope key off role, not this helper, so org-wide oversight never exposes salaries.
  if (context.role === "Training Manager") return true;

  const currentHrId = normalizeHrId(context.hrId);
  const employeeHrId = normalizeHrId(employee.hrId);

  if (!currentHrId || !employeeHrId) return false;

  if (hrIdsMatch(currentHrId, employeeHrId)) {
    return true;
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
  return rows.filter((row) => canSeeEmployee(context, row));
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

  const employees = filterEmployeesForAccess(directory.employees, context);
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
 * Workflow Control Center (Admin / Governance) access design.
 *
 * Phase 1 is a READ-ONLY workflow map + simulator. Access is restricted to HR
 * governance: Super Admin only. HR Manager is a manager title held by a Super
 * Admin account. Talent Acquisition is intentionally excluded, as are CEO,
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
