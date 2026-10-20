import { devPreviewRoleMismatch } from "@/lib/auth/dev-preview";
import { normalizeRole, type PhoenixRole } from "@/lib/auth/permissions";
import {
  getEmployeeDirectory,
  isActiveDirectoryEmployee,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type DevPreviewCandidate = {
  areaName: string | null;
  fullName: string;
  hrId: string;
  lineName: string | null;
  regionName: string | null;
};

export type DevPreviewCandidateFilters = {
  areaName?: string | null;
  lineName?: string | null;
  regionName?: string | null;
};

type ActiveRoleAssignment = {
  hrId: string;
  role: PhoenixRole;
};

async function loadActiveRoleAssignments(): Promise<ActiveRoleAssignment[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("hr_id, role")
    .eq("is_active", true)
    .not("hr_id", "is", null);

  if (error) throw error;

  return ((data ?? []) as Array<{ hr_id: string | null; role: string | null }>)
    .map((row) => {
      const hrId = canonicalHrIdForDisplay(row.hr_id);
      return hrId ? { hrId, role: normalizeRole(row.role) } : null;
    })
    .filter((row): row is ActiveRoleAssignment => row !== null);
}

async function loadActiveEmployeesByHrId(): Promise<Map<string, EmployeeDirectoryRow>> {
  const directory = await getEmployeeDirectory();
  const map = new Map<string, EmployeeDirectoryRow>();

  for (const employee of directory.employees) {
    if (!isActiveDirectoryEmployee(employee)) continue;
    const hrId = canonicalHrIdForDisplay(employee.hrId);
    if (hrId) map.set(hrId, employee);
  }

  return map;
}

function toCandidate(employee: EmployeeDirectoryRow): DevPreviewCandidate {
  return {
    areaName: employee.areaName,
    fullName: employee.fullName,
    hrId: employee.hrId,
    lineName: employee.lineName,
    regionName: employee.regionName,
  };
}

function matchesFilters(candidate: DevPreviewCandidate, filters: DevPreviewCandidateFilters) {
  if (filters.lineName && candidate.lineName !== filters.lineName) return false;
  if (filters.regionName && candidate.regionName !== filters.regionName) return false;
  if (filters.areaName && candidate.areaName !== filters.areaName) return false;
  return true;
}

/**
 * Every real, active employee holding `role` — the full line/region/area/name
 * catalog the client-side picker cascades through (Role -> Line -> Region ->
 * Area -> Name), so each dropdown only ever offers choices the next level can
 * actually resolve to a real preview candidate.
 */
export async function listDevPreviewCandidates(role: PhoenixRole): Promise<DevPreviewCandidate[]> {
  const [assignments, activeEmployeesByHrId] = await Promise.all([
    loadActiveRoleAssignments(),
    loadActiveEmployeesByHrId(),
  ]);

  const candidateHrIds = assignments
    .filter((assignment) => assignment.role === role)
    .map((assignment) => assignment.hrId);

  return candidateHrIds
    .map((hrId) => activeEmployeesByHrId.get(hrId))
    .filter((employee): employee is EmployeeDirectoryRow => Boolean(employee))
    .map(toCandidate)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/**
 * The same catalog for several roles in ONE read of the logins and the directory — the View as Seat
 * picker (src/components/admin/seat-view-picker.tsx) offers every portal seat at once, and asking
 * `listDevPreviewCandidates` once per seat would read both tables once per seat.
 */
export async function listDevPreviewCandidatesByRole(
  roles: readonly PhoenixRole[],
): Promise<Partial<Record<PhoenixRole, DevPreviewCandidate[]>>> {
  const [assignments, activeEmployeesByHrId] = await Promise.all([
    loadActiveRoleAssignments(),
    loadActiveEmployeesByHrId(),
  ]);

  const byRole: Partial<Record<PhoenixRole, DevPreviewCandidate[]>> = {};
  for (const role of roles) {
    byRole[role] = assignments
      .filter((assignment) => assignment.role === role)
      .map((assignment) => activeEmployeesByHrId.get(assignment.hrId))
      .filter((employee): employee is EmployeeDirectoryRow => Boolean(employee))
      .filter((employee, index, list) => list.findIndex((other) => other.hrId === employee.hrId) === index)
      .map(toCandidate)
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  return byRole;
}

/**
 * Auto-picks one real, active employee holding `role` that matches the given
 * line/region/area filters (any of which may be omitted). Deterministic
 * (alphabetical by name) rather than random, so the same filters always
 * resolve to the same preview.
 */
export async function findDevPreviewCandidate(
  role: PhoenixRole,
  filters: DevPreviewCandidateFilters,
): Promise<DevPreviewCandidate | null> {
  const candidates = await listDevPreviewCandidates(role);
  return candidates.find((candidate) => matchesFilters(candidate, filters)) ?? null;
}

/**
 * Resolves an explicitly chosen employee (picked by name in the UI) — verifies
 * they are a real, active employee currently holding `role` before handing
 * back a candidate, so a stale/forged hrId can never be used to preview as
 * someone who no longer holds that role.
 */
export async function findDevPreviewCandidateByHrId(
  role: PhoenixRole,
  hrId: string,
): Promise<DevPreviewCandidate | null> {
  const targetHrId = canonicalHrIdForDisplay(hrId);
  if (!targetHrId) return null;

  const candidates = await listDevPreviewCandidates(role);
  return candidates.find((candidate) => candidate.hrId === targetHrId) ?? null;
}

/**
 * The same guarantee `findDevPreviewCandidateByHrId` gives the Super Admin picker, for the bare
 * `/api/dev-auth` route, which takes any role and any hrId straight from the query string: when the
 * hrId belongs to someone with an active login, the preview must use a role that login holds.
 * Returns the person's real role and name when it does not, or null when the preview may proceed.
 */
export async function findDevPreviewRoleMismatch(
  role: PhoenixRole,
  hrId: string,
): Promise<{ actualRole: PhoenixRole; fullName: string | null } | null> {
  const [assignments, activeEmployeesByHrId] = await Promise.all([
    loadActiveRoleAssignments(),
    loadActiveEmployeesByHrId(),
  ]);

  const actualRole = devPreviewRoleMismatch(role, hrId, assignments);
  if (!actualRole) return null;

  const canonical = canonicalHrIdForDisplay(hrId);
  return { actualRole, fullName: (canonical ? activeEmployeesByHrId.get(canonical)?.fullName : null) ?? null };
}
