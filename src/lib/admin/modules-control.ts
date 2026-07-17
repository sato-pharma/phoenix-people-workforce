import { cache } from "react";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { getAccessControlDashboard, type AccessActor } from "@/lib/admin/access-control";
import {
  getNavigationSections,
  type NavigationPermission,
} from "@/config/system-navigation";
import {
  getPermissionMatrix,
  phoenixRoles,
  type AccessContext,
  type NavigationMode,
  type PermissionAction,
  type PermissionMap,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ModuleControlTargetType = "user" | "role" | "position" | "line";
export type ModuleControlNavigationMode = NavigationMode;

export type ModuleControlCatalogModule = {
  excludedRoles: PhoenixRole[];
  href: string;
  label: string;
  moduleId: string;
  navigationMode: ModuleControlNavigationMode;
  permissions: { action: PermissionAction; resource: PermissionResource }[];
  roles: PhoenixRole[];
  sectionId: string;
  sectionLabel: string;
};

export type ModuleControlPerson = {
  hrId: string | null;
  isActive: boolean;
  line: string | null;
  loginId: string;
  name: string;
  positionTitle: string | null;
  role: PhoenixRole;
};

export type ModuleControlTargetOption = {
  activeUserCount?: number;
  hrId?: string | null;
  label: string;
  line?: string | null;
  loginId?: string | null;
  name?: string | null;
  positionTitle?: string | null;
  role?: PhoenixRole | null;
  type: ModuleControlTargetType;
  value: string;
};

export type ModuleControlAssignment = {
  createdAt: string | null;
  id: string;
  isEnabled: boolean;
  moduleId: string;
  navigationMode: ModuleControlNavigationMode;
  sortOrder: number;
  targetKey: string;
  targetType: ModuleControlTargetType;
  updatedAt: string | null;
};

export type ModuleControlDashboard = {
  assignments: ModuleControlAssignment[];
  catalog: ModuleControlCatalogModule[];
  defaultModuleIds: Record<ModuleControlNavigationMode, string[]>;
  permissions: PermissionMap;
  targets: {
    lines: ModuleControlTargetOption[];
    positions: ModuleControlTargetOption[];
    roles: ModuleControlTargetOption[];
    users: ModuleControlTargetOption[];
  };
};

export type ModuleControlMutationInput = {
  governanceReason?: string | null;
  moduleIds: string[];
  navigationMode: ModuleControlNavigationMode;
  targetKey: string;
  targetType: ModuleControlTargetType;
};

type SidebarModuleAssignmentRow = {
  created_at?: string | null;
  id?: string | null;
  is_enabled?: boolean | null;
  module_id?: string | null;
  navigation_mode?: string | null;
  sort_order?: number | null;
  target_key?: string | null;
  target_type?: string | null;
  updated_at?: string | null;
};

const targetTypes: readonly ModuleControlTargetType[] = ["user", "role", "position", "line"];
const navigationModes: readonly ModuleControlNavigationMode[] = ["admin", "employee-portal"];

function normalizeKey(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function compact<T>(values: Array<T | null | undefined>) {
  return values.filter((value): value is T => value !== null && typeof value !== "undefined");
}

function permissionRefs(permissions?: readonly NavigationPermission[]) {
  return (permissions ?? []).map((permission) => ({
    action: permission.action ?? "read",
    resource: permission.resource,
  }));
}

export function buildModuleCatalog(): ModuleControlCatalogModule[] {
  return navigationModes.flatMap((navigationMode) =>
    getNavigationSections(navigationMode).flatMap((section) =>
      section.items.map((item) => ({
        excludedRoles: [...(item.excludedRoles ?? [])],
        href: item.href,
        label: item.label,
        moduleId: item.moduleId,
        navigationMode,
        permissions: permissionRefs(item.permissions),
        roles: [...(item.roles ?? [])],
        sectionId: section.id,
        sectionLabel: section.label,
      })),
    ),
  );
}

function moduleById(catalog: readonly ModuleControlCatalogModule[]) {
  return new Map(catalog.map((navModule) => [navModule.moduleId, navModule]));
}

function toAssignment(row: SidebarModuleAssignmentRow): ModuleControlAssignment {
  return {
    createdAt: row.created_at ?? null,
    id: String(row.id ?? ""),
    isEnabled: row.is_enabled !== false,
    moduleId: String(row.module_id ?? ""),
    navigationMode: parseNavigationMode(row.navigation_mode),
    sortOrder: Number(row.sort_order ?? 0),
    targetKey: String(row.target_key ?? ""),
    targetType: parseTargetType(row.target_type),
    updatedAt: row.updated_at ?? null,
  };
}

function parseTargetType(value: string | null | undefined): ModuleControlTargetType {
  if (targetTypes.includes(value as ModuleControlTargetType)) return value as ModuleControlTargetType;
  throw validationError("targetType must be one of: user, role, position, line.");
}

function parseNavigationMode(value: string | null | undefined): ModuleControlNavigationMode {
  if (navigationModes.includes(value as ModuleControlNavigationMode)) return value as ModuleControlNavigationMode;
  throw validationError("navigationMode must be admin or employee-portal.");
}

function optionalReason(value: unknown) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw validationError("governanceReason must be a string.");
  }
  const reason = String(value).trim();
  if (reason.length > 500) throw validationError("governanceReason must be 500 characters or fewer.");
  return reason || null;
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw validationError(`${field} is required.`);
  }
  const normalized = String(value).trim();
  if (!normalized) throw validationError(`${field} is required.`);
  return normalized;
}

function moduleIdList(value: unknown) {
  if (!Array.isArray(value)) throw validationError("moduleIds must be an array.");
  const unique = new Set<string>();
  for (const entry of value) {
    const moduleId = requiredString(entry, "moduleId");
    unique.add(moduleId);
  }
  if (unique.size === 0) {
    throw validationError("Select at least one module, or use reset to return the target to default sidebar behavior.");
  }
  return [...unique];
}

export function parseModuleControlMutationRequest(body: unknown): ModuleControlMutationInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw validationError("Request body must be a JSON object.");
  }
  const payload = body as Record<string, unknown>;
  return {
    governanceReason: optionalReason(payload.governanceReason),
    moduleIds: moduleIdList(payload.moduleIds),
    navigationMode: parseNavigationMode(requiredString(payload.navigationMode, "navigationMode")),
    targetKey: normalizeKey(requiredString(payload.targetKey, "targetKey")),
    targetType: parseTargetType(requiredString(payload.targetType, "targetType")),
  };
}

export function parseModuleControlResetRequest(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw validationError("Request body must be a JSON object.");
  }
  const payload = body as Record<string, unknown>;
  return {
    governanceReason: optionalReason(payload.governanceReason),
    navigationMode: parseNavigationMode(requiredString(payload.navigationMode, "navigationMode")),
    targetKey: normalizeKey(requiredString(payload.targetKey, "targetKey")),
    targetType: parseTargetType(requiredString(payload.targetType, "targetType")),
  };
}

async function getPeople(): Promise<ModuleControlPerson[]> {
  const [dashboard, directory] = await Promise.all([
    getAccessControlDashboard(),
    getEmployeeDirectory().catch(() => null),
  ]);
  const employeesByHrId = new Map(
    (directory?.employees ?? []).map((employee) => [normalizeKey(employee.hrId), employee]),
  );

  return dashboard.users.map((user) => {
    const employee = user.hrId ? employeesByHrId.get(normalizeKey(user.hrId)) : undefined;
    return {
      hrId: user.hrId,
      isActive: user.isActive,
      line: user.line ?? employee?.lineName ?? null,
      loginId: user.loginId,
      name: user.name,
      positionTitle: employee?.positionTitle ?? employee?.jobTitle ?? null,
      role: user.role,
    };
  });
}

function personLabel(person: ModuleControlPerson) {
  return person.hrId || person.loginId || person.name;
}

function targetLabel(targetType: ModuleControlTargetType, targetKey: string) {
  return `${targetType}:${targetKey}`;
}

function buildTargetOptions(people: readonly ModuleControlPerson[]) {
  const activePeople = people.filter((person) => person.isActive);
  const users: ModuleControlTargetOption[] = activePeople.map((person) => ({
    hrId: person.hrId,
    label: `${person.hrId ?? person.loginId} - ${person.name} (${person.role})`,
    line: person.line,
    loginId: person.loginId,
    name: person.name,
    positionTitle: person.positionTitle,
    role: person.role,
    type: "user",
    value: normalizeKey(person.hrId ?? person.loginId),
  }));

  const countBy = (selector: (person: ModuleControlPerson) => string | null | undefined) => {
    const counts = new Map<string, number>();
    for (const person of activePeople) {
      const key = normalizeKey(selector(person));
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };

  const roleCounts = countBy((person) => person.role);
  const positionCounts = countBy((person) => person.positionTitle);
  const lineCounts = countBy((person) => person.line);

  const roles: ModuleControlTargetOption[] = phoenixRoles.map((role) => ({
    activeUserCount: roleCounts.get(normalizeKey(role)) ?? 0,
    label: `${role} (${roleCounts.get(normalizeKey(role)) ?? 0} active)`,
    role,
    type: "role",
    value: normalizeKey(role),
  }));

  const positions = [...positionCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => ({
      activeUserCount: count,
      label: `${value} (${count} active)`,
      positionTitle: value,
      type: "position" as const,
      value,
    }));

  const lines = [...lineCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => ({
      activeUserCount: count,
      label: `${value} (${count} active)`,
      line: value,
      type: "line" as const,
      value,
    }));

  return { lines, positions, roles, users };
}

function defaultModuleIds(catalog: readonly ModuleControlCatalogModule[]) {
  return {
    admin: catalog.filter((navModule) => navModule.navigationMode === "admin").map((navModule) => navModule.moduleId),
    "employee-portal": catalog.filter((navModule) => navModule.navigationMode === "employee-portal").map((navModule) => navModule.moduleId),
  };
}

async function listAssignments(): Promise<ModuleControlAssignment[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sidebar_module_assignments")
    .select("id,target_type,target_key,navigation_mode,module_id,sort_order,is_enabled,created_at,updated_at")
    .order("target_type", { ascending: true })
    .order("target_key", { ascending: true })
    .order("navigation_mode", { ascending: true })
    .order("sort_order", { ascending: true });

  if (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }

  return ((data ?? []) as SidebarModuleAssignmentRow[]).map(toAssignment);
}

export async function getModuleControlDashboard(): Promise<ModuleControlDashboard> {
  const [people, permissions, assignments] = await Promise.all([
    getPeople(),
    getPermissionMatrix(),
    listAssignments(),
  ]);
  const catalog = buildModuleCatalog();
  return {
    assignments,
    catalog,
    defaultModuleIds: defaultModuleIds(catalog),
    permissions,
    targets: buildTargetOptions(people),
  };
}

function findAffectedPeople(
  people: readonly ModuleControlPerson[],
  targetType: ModuleControlTargetType,
  targetKey: string,
) {
  const normalizedTargetKey = normalizeKey(targetKey);
  const activePeople = people.filter((person) => person.isActive);
  switch (targetType) {
    case "user":
      return activePeople.filter(
        (person) =>
          normalizeKey(person.loginId) === normalizedTargetKey ||
          normalizeKey(person.hrId) === normalizedTargetKey,
      );
    case "role":
      return activePeople.filter((person) => normalizeKey(person.role) === normalizedTargetKey);
    case "position":
      return activePeople.filter((person) => normalizeKey(person.positionTitle) === normalizedTargetKey);
    case "line":
      return activePeople.filter((person) => normalizeKey(person.line) === normalizedTargetKey);
    default:
      return [];
  }
}

function requiredPermissionLabel(navModule: ModuleControlCatalogModule) {
  if (navModule.permissions.length === 0) return "no backend permission";
  return navModule.permissions
    .map((permission) => `${permission.resource}:${permission.action}`)
    .join(" or ");
}

function validateModuleForPerson(
  navModule: ModuleControlCatalogModule,
  person: ModuleControlPerson,
  matrix: PermissionMap,
): string | null {
  if (navModule.roles.length > 0 && !navModule.roles.includes(person.role)) {
    return `Blocked: ${personLabel(person)} is ${person.role}. ${navModule.label} is limited to ${navModule.roles.join(", ")}.`;
  }

  if (navModule.navigationMode === "employee-portal" && navModule.excludedRoles.includes(person.role)) {
    return `Blocked: ${personLabel(person)} is ${person.role}. ${navModule.label} excludes ${person.role}.`;
  }

  if (navModule.permissions.length > 0) {
    const allowed = navModule.permissions.some((permission) =>
      matrix[person.role]?.[permission.resource]?.includes(permission.action) ?? false,
    );
    if (!allowed) {
      return `Blocked: ${personLabel(person)} is ${person.role}. ${navModule.label} requires ${requiredPermissionLabel(navModule)}.`;
    }
  }

  return null;
}

export function validateModuleAssignmentList(input: {
  catalog: readonly ModuleControlCatalogModule[];
  matrix: PermissionMap;
  moduleIds: readonly string[];
  navigationMode: ModuleControlNavigationMode;
  people: readonly ModuleControlPerson[];
  targetKey: string;
  targetType: ModuleControlTargetType;
}) {
  const catalogById = moduleById(input.catalog);
  const affectedPeople = findAffectedPeople(input.people, input.targetType, input.targetKey);
  if (affectedPeople.length === 0) {
    throw validationError(`No active access account matched ${targetLabel(input.targetType, input.targetKey)}.`);
  }

  for (const moduleId of input.moduleIds) {
    const navModule = catalogById.get(moduleId);
    if (!navModule) {
      throw validationError(`Module ${moduleId} does not exist in the system navigation catalog.`);
    }
    if (navModule.navigationMode !== input.navigationMode) {
      throw validationError(`Module ${navModule.label} belongs to ${navModule.navigationMode}, not ${input.navigationMode}.`);
    }

    for (const person of affectedPeople) {
      const reason = validateModuleForPerson(navModule, person, input.matrix);
      if (reason) {
        throw validationError(reason, "module_assignment_blocked");
      }
    }
  }

  return {
    affectedPeople,
    moduleIds: [...input.moduleIds],
  };
}

function assignmentEntityId(targetType: ModuleControlTargetType, targetKey: string, navigationMode: ModuleControlNavigationMode) {
  return `${targetType}:${targetKey}:${navigationMode}`;
}

async function previousRowsFor(
  targetType: ModuleControlTargetType,
  targetKey: string,
  navigationMode: ModuleControlNavigationMode,
) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sidebar_module_assignments")
    .select("id,target_type,target_key,navigation_mode,module_id,sort_order,is_enabled,created_by,updated_by,created_at,updated_at")
    .eq("target_type", targetType)
    .eq("target_key", targetKey)
    .eq("navigation_mode", navigationMode)
    .order("sort_order", { ascending: true });

  if (error) throw error;
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function restoreRows(rows: Array<Record<string, unknown>>) {
  const supabase = getSupabaseAdmin();
  if (rows.length === 0) return;
  const { error } = await supabase.from("sidebar_module_assignments").insert(rows);
  if (error) {
    console.error(JSON.stringify({
      context: "sidebar_module_assignments_restore",
      error: error.message,
      event: "module_control_compensation_failed",
    }));
  }
}

async function deleteRows(
  targetType: ModuleControlTargetType,
  targetKey: string,
  navigationMode: ModuleControlNavigationMode,
) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("sidebar_module_assignments")
    .delete()
    .eq("target_type", targetType)
    .eq("target_key", targetKey)
    .eq("navigation_mode", navigationMode);
  if (error) throw error;
}

export async function saveModuleControlAssignments(
  input: ModuleControlMutationInput,
  actor?: AccessActor | null,
) {
  if (actor?.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can update Modules Control.");
  }

  const [people, matrix] = await Promise.all([getPeople(), getPermissionMatrix()]);
  const catalog = buildModuleCatalog();
  const validation = validateModuleAssignmentList({
    catalog,
    matrix,
    moduleIds: input.moduleIds,
    navigationMode: input.navigationMode,
    people,
    targetKey: input.targetKey,
    targetType: input.targetType,
  });

  const previousRows = await previousRowsFor(input.targetType, input.targetKey, input.navigationMode);
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const rows = validation.moduleIds.map((moduleId, index) => ({
    created_by: actor?.loginId ?? null,
    is_enabled: true,
    module_id: moduleId,
    navigation_mode: input.navigationMode,
    sort_order: index,
    target_key: input.targetKey,
    target_type: input.targetType,
    updated_at: now,
    updated_by: actor?.loginId ?? null,
  }));

  try {
    await deleteRows(input.targetType, input.targetKey, input.navigationMode);
    const { error } = await supabase.from("sidebar_module_assignments").insert(rows);
    if (error) throw error;

    await writeRequiredAuditLog({
      actorLoginId: actor?.loginId ?? null,
      entityId: assignmentEntityId(input.targetType, input.targetKey, input.navigationMode),
      entityType: "module_control_assignment",
      newValues: {
        affectedUsers: validation.affectedPeople.map((person) => personLabel(person)),
        moduleIds: input.moduleIds,
        navigationMode: input.navigationMode,
        reason: input.governanceReason ?? null,
        targetKey: input.targetKey,
        targetType: input.targetType,
      },
      oldValues: {
        moduleIds: previousRows.map((row) => row.module_id),
      },
      summary: `Modules Control saved ${input.moduleIds.length} modules for ${input.targetType}:${input.targetKey} (${input.navigationMode})`,
    });
  } catch (error) {
    await deleteRows(input.targetType, input.targetKey, input.navigationMode).catch(() => undefined);
    await restoreRows(previousRows);
    throw error;
  }

  return getModuleControlDashboard();
}

export async function resetModuleControlAssignments(
  input: Omit<ModuleControlMutationInput, "moduleIds">,
  actor?: AccessActor | null,
) {
  if (actor?.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can reset Modules Control.");
  }

  const previousRows = await previousRowsFor(input.targetType, input.targetKey, input.navigationMode);
  try {
    await deleteRows(input.targetType, input.targetKey, input.navigationMode);
    await writeRequiredAuditLog({
      actorLoginId: actor?.loginId ?? null,
      entityId: assignmentEntityId(input.targetType, input.targetKey, input.navigationMode),
      entityType: "module_control_assignment",
      newValues: {
        moduleIds: [],
        navigationMode: input.navigationMode,
        reason: input.governanceReason ?? null,
        resetToDefault: true,
        targetKey: input.targetKey,
        targetType: input.targetType,
      },
      oldValues: {
        moduleIds: previousRows.map((row) => row.module_id),
      },
      summary: `Modules Control reset ${input.targetType}:${input.targetKey} (${input.navigationMode}) to default sidebar`,
    });
  } catch (error) {
    await restoreRows(previousRows);
    throw error;
  }

  return getModuleControlDashboard();
}

async function lookupUserForAccess(access: AccessContext) {
  const supabase = getSupabaseAdmin();
  if (access.loginId) {
    const { data, error } = await supabase
      .from("app_auth_users")
      .select("login_id,hr_id,role,line,is_active")
      .eq("login_id", access.loginId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data as Record<string, unknown>;
  }
  if (access.hrId) {
    const { data, error } = await supabase
      .from("app_auth_users")
      .select("login_id,hr_id,role,line,is_active")
      .eq("hr_id", access.hrId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data as Record<string, unknown>;
  }
  return null;
}

async function lookupEmployeePosition(hrId: string | null | undefined) {
  if (!hrId) return { line: null, positionTitle: null };
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("job_title,line_id,position_id,lines(name),positions(title)")
    .eq("hr_id", String(hrId).toUpperCase())
    .maybeSingle();
  if (error) {
    return { line: null, positionTitle: null };
  }
  const row = (data ?? {}) as {
    job_title?: string | null;
    lines?: { name?: string | null } | null;
    positions?: { title?: string | null } | null;
  };
  return {
    line: row.lines?.name ?? null,
    positionTitle: row.positions?.title ?? row.job_title ?? null,
  };
}

type AssignmentCandidate = { keys: string[]; type: ModuleControlTargetType };

/**
 * One batched query replacing the old per-candidate probe loop (up to 5 sequential
 * round trips — all paid for nothing whenever the table is empty). `.in()` filters
 * are per-column, so a target_key that coincidentally exists under a different
 * target_type can slip into the result set; the exact (type, key) pair grouping
 * below restores the loop's per-candidate semantics before precedence is applied.
 * Rows arrive ordered by sort_order, so each pair's bucket keeps the same order
 * the per-candidate query produced.
 */
async function assignmentRowsForCandidates(
  candidates: readonly AssignmentCandidate[],
  navigationMode: ModuleControlNavigationMode,
): Promise<Map<string, Array<{ module_id?: string | null; sort_order?: number | null }>>> {
  const pairs = candidates.flatMap((candidate) => candidate.keys.map((key) => ({ key, type: candidate.type })));
  const byPair = new Map<string, Array<{ module_id?: string | null; sort_order?: number | null }>>();
  if (pairs.length === 0) return byPair;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sidebar_module_assignments")
    .select("target_type,target_key,module_id,sort_order,is_enabled")
    .eq("navigation_mode", navigationMode)
    .eq("is_enabled", true)
    .in("target_type", [...new Set(pairs.map((pair) => pair.type))])
    .in("target_key", [...new Set(pairs.map((pair) => pair.key))])
    .order("sort_order", { ascending: true });
  if (error) {
    // Missing table behaves exactly like the old loop: every probe returns empty.
    if ((error as { code?: string }).code === "42P01") return byPair;
    throw error;
  }

  for (const row of (data ?? []) as Array<{
    target_type?: string | null;
    target_key?: string | null;
    module_id?: string | null;
    sort_order?: number | null;
  }>) {
    const pairKey = `${String(row.target_type ?? "")}:${String(row.target_key ?? "")}`;
    const bucket = byPair.get(pairKey) ?? [];
    bucket.push({ module_id: row.module_id, sort_order: row.sort_order });
    byPair.set(pairKey, bucket);
  }
  return byPair;
}

// Per-request memoized: AppShell resolves the effective sidebar once per navigation, but the same
// (access, navigationMode) can be requested by multiple server components in one render. cache()
// dedupes the lookupUserForAccess + lookupEmployeePosition + assignment queries to one pass. Keyed
// by the access OBJECT — callers pass the same cached AccessContext from resolveAccessContextFromPage,
// so the reference matches within a request.
export const getEffectiveSidebarModuleIds = cache(async (
  access: AccessContext,
  navigationMode: ModuleControlNavigationMode,
): Promise<string[] | null> => {
  if (!access.loginId && !access.hrId) return null;

  // The user lookup, the employees position lookup, and the permission matrix are
  // dependency-free (the employees lookup is fired speculatively on access.hrId and
  // reused only when the resolved user row keys to the same employees lookup key),
  // so run them concurrently. Errors are re-thrown in the original sequential order:
  // user lookup first, then employee lookup, then permission matrix.
  const [userSettled, speculativeEmployeeSettled, matrixSettled] = await Promise.all([
    lookupUserForAccess(access).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    lookupEmployeePosition(access.hrId ?? null).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    getPermissionMatrix().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);

  if (!userSettled.ok) throw userSettled.error;
  const user = userSettled.value;
  const userHrId = String(user?.hr_id ?? access.hrId ?? "").trim() || null;
  const userLoginId = String(user?.login_id ?? access.loginId ?? "").trim() || null;
  const userRole = access.role;

  // lookupEmployeePosition keys its query on `hrId ? String(hrId).toUpperCase() : none`;
  // reuse the speculative result only when both inputs produce that exact same key.
  const positionLookupKey = (hrId: string | null | undefined) => (hrId ? String(hrId).toUpperCase() : null);
  let employee: { line: string | null; positionTitle: string | null };
  if (positionLookupKey(userHrId) === positionLookupKey(access.hrId ?? null)) {
    if (!speculativeEmployeeSettled.ok) throw speculativeEmployeeSettled.error;
    employee = speculativeEmployeeSettled.value;
  } else {
    employee = await lookupEmployeePosition(userHrId);
  }
  const line = String(user?.line ?? employee.line ?? "").trim() || null;
  const positionTitle = employee.positionTitle;

  const candidates: Array<{ keys: string[]; type: ModuleControlTargetType }> = [
    { type: "user", keys: compact([normalizeKey(userHrId), normalizeKey(userLoginId)]).filter(Boolean) },
    { type: "role", keys: [normalizeKey(userRole)] },
    { type: "position", keys: compact([normalizeKey(positionTitle)]).filter(Boolean) },
    { type: "line", keys: compact([normalizeKey(line)]).filter(Boolean) },
  ];

  const catalog = moduleById(buildModuleCatalog());
  if (!matrixSettled.ok) throw matrixSettled.error;
  const matrix = matrixSettled.value;

  // ONE batched query for every candidate pair; precedence selection stays in code,
  // in exactly the order the sequential probe loop used (user:hrId, user:loginId,
  // role, position, line — first candidate with any DB rows wins, even if catalog
  // filtering then empties it).
  const rowsByPair = await assignmentRowsForCandidates(candidates, navigationMode);

  for (const candidate of candidates) {
    for (const key of candidate.keys) {
      const rows = rowsByPair.get(`${candidate.type}:${key}`) ?? [];
      if (rows.length === 0) continue;
      return rows
        .map((row) => String(row.module_id ?? ""))
        .filter((moduleId) => {
          const navModule = catalog.get(moduleId);
          if (!navModule || navModule.navigationMode !== navigationMode) return false;
          return !validateModuleForPerson(navModule, {
            hrId: userHrId,
            isActive: Boolean(user?.is_active ?? true),
            line,
            loginId: userLoginId ?? "",
            name: userLoginId ?? userHrId ?? "User",
            positionTitle,
            role: userRole,
          }, matrix);
        });
    }
  }

  return null;
});
