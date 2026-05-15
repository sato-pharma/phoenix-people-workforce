import type { EmployeeDirectoryData, EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
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
  "HR Specialist",
  "Manager",
  "CEO",
  "Super Admin",
] as const;
export type PhoenixRole = (typeof phoenixRoles)[number];

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
  | "imports"
  | "sales"
  | "payroll"
  | "payslips"
  | "expenses"
  | "vacancies"
  | "organogram"
  | "offers"
  | "probation"
  | "resignations"
  | "contracts"
  | "coaching"
  | "hr_calendar"
  | "outstation"
  | "leave"
  | "admin"
  | "user_admin"
  | "permission_admin";

export const permissionResources: PermissionResource[] = [
  "admin",
  "overview",
  "admin_access",
  "imports",
  "sales",
  "payroll",
  "expenses",
  "employees",
  "team",
  "offers",
  "probation",
  "resignations",
  "contracts",
  "coaching",
  "user_admin",
  "permission_admin",
  "employee_documents",
  "employee_profile",
  "vacancies",
  "organogram",
  "hr_calendar",
  "payslips",
  "outstation",
  "leave",
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
  source: "session" | "system" | "dev-header";
};

export type PermissionMap = Record<PhoenixRole, Partial<Record<PermissionResource, PermissionAction[]>>>;
type PermissionDbOverrideRow = {
  role_name: string | null;
  resource: string | null;
  action: string | null;
  is_allowed: boolean | null;
};

const allActions: PermissionAction[] = ["read", "create", "update", "delete", "approve", "export", "import"];
const portalNavigationRoles = new Set<PhoenixRole>([
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
  "CEO",
  "Manager",
]);

const defaultPermissionMatrix: PermissionMap = {
  "Super Admin": {
    admin: allActions,
    overview: ["read"],
    admin_access: ["read"],
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
    probation: allActions,
    resignations: allActions,
    permission_admin: allActions,
    sales: allActions,
    team: allActions,
    user_admin: allActions,
    vacancies: allActions,
  },
  CEO: {
    admin: allActions,
    overview: ["read"],
    admin_access: ["read"],
    imports: ["read", "import"],
    contracts: ["read", "approve", "export"],
    coaching: ["read"],
    employee_profile: ["read", "export"],
    employees: ["read", "export"],
    expenses: ["read", "approve", "export"],
    outstation: ["read", "approve", "export", "update"],
    leave: ["read", "approve", "export"],
    organogram: ["read", "export"],
    payroll: ["read", "export"],
    permission_admin: ["read"],
    payslips: ["read", "export"],
    resignations: ["read", "approve", "export"],
    sales: ["read", "export"],
    team: ["read", "export"],
    user_admin: ["read"],
    vacancies: ["read", "export"],
  },
  "HR Specialist": {
    admin: allActions,
    overview: ["read"],
    admin_access: ["read"],
    imports: ["read", "import"],
    contracts: allActions,
    coaching: ["read"],
    employee_documents: allActions,
    employee_profile: allActions,
    employees: allActions,
    expenses: allActions,
    hr_calendar: allActions,
    outstation: allActions,
    leave: allActions,
    organogram: ["read", "export"],
    offers: allActions,
    payroll: allActions,
    permission_admin: ["read"],
    payslips: allActions,
    probation: allActions,
    resignations: allActions,
    team: ["read", "export"],
    user_admin: ["read", "update"],
    vacancies: allActions,
  },
  "Finance Manager": {
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: allActions,
    outstation: ["read", "approve", "export", "update"],
    leave: ["read", "approve", "export", "update"],
    payroll: allActions,
    payslips: ["read", "export"],
    sales: ["read", "export"],
  },
  Employee: {
    overview: [],
    coaching: ["read"],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
  },
  "Medical Rep": {
    overview: [],
    coaching: ["read"],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
    payroll: ["read", "export"],
    sales: ["read", "export"],
    payslips: ["read", "export"],
  },
  "District Manager": {
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "approve", "export"],
    outstation: ["read", "create", "approve", "export"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    organogram: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    probation: ["read", "export"],
    sales: ["read", "export"],
    team: ["read", "export"],
    vacancies: ["read", "export"],
  },
  "Regional Manager": {
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "approve", "export"],
    outstation: ["read", "create", "approve", "export"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    organogram: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
    team: ["read", "export"],
  },
  "National Sales Manager": {
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "approve", "export"],
    outstation: ["read", "create", "approve", "export"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    probation: ["read", "export"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
    team: ["read", "export"],
    organogram: ["read"],
    vacancies: ["read", "export"],
  },
  "Product Manager": {
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
    coaching: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
  },
  "Group Product Manager": {
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
    coaching: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
  },
  "SFE Manager": {
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: allActions,
    coaching: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: allActions,
  },
  "Training Manager": {
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    employees: ["read", "export"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "export"],
    coaching: ["read", "create", "update"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    probation: ["read", "export"],
    team: ["read"],
  },
  "Marketing Manager": {
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    employees: ["read"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
    offers: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
  },
  Manager: {
    overview: [],
    employee_documents: ["read", "export"],
    employee_profile: ["read", "update"],
    employees: ["read", "export"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
    team: ["read", "export"],
  },
};

export const permissionMatrix: PermissionMap = structuredClone(defaultPermissionMatrix);

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
  const legacy: Record<string, PhoenixRole> = {
    dsm: "District Manager",
    "account admin": "Super Admin",
    admin: "Super Admin",
    employee: "Employee",
    nsm: "National Sales Manager",
    "employee medical rep": "Medical Rep",
    "medical rep": "Medical Rep",
    "medical representative": "Medical Rep",
    "district sales manager": "District Manager",
    "district manager": "District Manager",
    "regional manager": "Regional Manager",
    "regional sales manager": "Regional Manager",
    "national sales manager": "National Sales Manager",
    "product manager": "Product Manager",
    "group product manager": "Group Product Manager",
    "sfe manager": "SFE Manager",
    "training manager": "Training Manager",
    "marketing manager": "Marketing Manager",
    "finance manager": "Finance Manager",
    "hr manager": "HR Specialist",
    "hr specialist": "HR Specialist",
    manager: "Manager",
    ceo: "CEO",
    "super admin": "Super Admin",
  };
  if (legacy[normalized]) return legacy[normalized];

  const normalizedNoPunctuation = normalized.replace(/[^a-z0-9 ]/g, "");
  const legacyNoPunctuation: Record<string, PhoenixRole> = {
    accountadmin: "Super Admin",
    dsm: "District Manager",
    nsm: "National Sales Manager",
    employee: "Employee",
    districtsalesmanager: "District Manager",
    medicalrep: "Medical Rep",
    districtmanager: "District Manager",
    regionalmanager: "Regional Manager",
    regionalsalesmanager: "Regional Manager",
    nationalsalesmanager: "National Sales Manager",
    productmanager: "Product Manager",
    groupproductmanager: "Group Product Manager",
    sfemanager: "SFE Manager",
    trainingmanager: "Training Manager",
    marketingmanager: "Marketing Manager",
    financemanager: "Finance Manager",
    hrmanager: "HR Specialist",
    hrspecialist: "HR Specialist",
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

export function getRolePrivilegeRank(role: PhoenixRole) {
  switch (role) {
    case "Super Admin":
      return 400;
    case "CEO":
      return 300;
    case "HR Specialist":
      return 250;
    case "Finance Manager":
      return 200;
    default:
      return 100;
  }
}

export function normalizeHrId(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
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
  return portalNavigationRoles.has(context.role) ? "employee-portal" : "admin";
}

export function canManageCoachingReports(context: Pick<AccessContext, "role" | "scope">) {
  return context.scope === "system" || context.role === "Super Admin" || context.role === "Training Manager";
}

export function scopeForRole(role: PhoenixRole): AccessScope {
  if (
    role === "Super Admin" ||
    role === "CEO" ||
    role === "HR Specialist" ||
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

  return {
    hrId: normalizeHrId(input.hrId),
    loginId: input.loginId ?? null,
    role,
    scope: scopeForRole(role),
    source: input.source ?? "session",
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

  return merged;
}

async function getPermissionMatrixFromDb(): Promise<PermissionMatrix> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("role_permission_overrides")
      .select("role_name,resource,action,is_allowed");

    if (error || !data) {
      return clonePermissionMatrix(defaultPermissionMatrix);
    }

    return toPermissionMatrix(data as PermissionDbOverrideRow[]);
  } catch {
    return clonePermissionMatrix(defaultPermissionMatrix);
  }
}

async function resolvePermissionMatrix(): Promise<PermissionMatrix> {
  if (permissionCache && permissionCache.fetchedAt + permissionCacheMs > Date.now()) {
    return permissionCache.matrix;
  }

  if (!permissionMatrixPromise) {
    permissionMatrixPromise = getPermissionMatrixFromDb().then((matrix) => {
      permissionCache = { fetchedAt: Date.now(), matrix };
      return matrix;
    }).finally(() => {
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
    case "SFE Manager":
    case "CEO":
    case "Super Admin":
      return "COMPANY";
    default:
      return "NONE";
  }
}

export function getPayrollScope(context: Pick<AccessContext, "role">): BusinessScope {
  if (
    context.role === "CEO" ||
    context.role === "HR Specialist" ||
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
    case "CEO":
    case "HR Specialist":
    case "Finance Manager":
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
  if (context.scope === "system" || getPayrollScope(context) === "COMPANY") return true;
  return hrIdsMatch(context.hrId, target.employeeHrId ?? target.hrId);
}

export function canAccessSales(
  context: AccessContext,
  record: { employeeHrId?: string | null; hrId?: string | null; managerHrId?: string | null; line?: string | null },
  viewer?: { line?: string | null },
) {
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

export function canSeeEmployee(context: AccessContext, employee: Pick<EmployeeDirectoryRow, "hrId" | "managerHrId">) {
  if (context.scope === "system" || context.role === "Super Admin" || context.role === "HR Specialist") return true;

  const currentHrId = normalizeHrId(context.hrId);
  const employeeHrId = normalizeHrId(employee.hrId);

  if (!currentHrId || !employeeHrId) return false;
  
  // Allow managers to see their direct reports regardless of role
  if (hrIdsMatch(currentHrId, employeeHrId) || isDirectReport(currentHrId, employee)) {
    return true;
  }

  return false;
}

export function canSeeHrScopedRecord(
  context: AccessContext,
  record: {
    employeeHrId?: string | null;
    hrId?: string | null;
    managerHrId?: string | null;
  },
) {
  if (context.scope === "system" || context.role === "Super Admin" || context.role === "HR Specialist") return true;

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
  if (context.scope === "system" || context.role === "Super Admin" || context.role === "HR Specialist") return directory;

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
