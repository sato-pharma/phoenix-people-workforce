import {
  normalizeHrId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";

export type EmployeeCoachingPortalMode = "self" | "team";

function isMedicalRepTitle(value: string | null | undefined) {
  return resolveJobFunctionRole(value) === "Medical Rep";
}

export async function resolveEmployeeCoachingPortalMode(
  access: AccessContext,
): Promise<EmployeeCoachingPortalMode | null> {
  // Regional Manager gets the team view like DSM/NSM. The row-level scope is enforced downstream by
  // canAccessCoachingEmployee (coaching/service.ts), which already bounds an RM to their own
  // management subtree via isWithinManagerHierarchy — this only decides WHICH view renders, never
  // which reports are visible in it.
  if (
    access.role === "District Manager" ||
    access.role === "Regional Manager" ||
    access.role === "National Sales Manager"
  ) {
    return "team";
  }

  if (access.role === "Medical Rep") {
    return "self";
  }

  const hrId = normalizeHrId(access.hrId);
  if (!hrId) return null;

  const rows = await getEmployeeDirectoryRows();
  const employee = rows.find((row) => normalizeHrId(row.hrId) === hrId);
  if (!employee) return null;

  return isMedicalRepTitle(employee.jobTitle) || isMedicalRepTitle(employee.positionTitle)
    ? "self"
    : null;
}
