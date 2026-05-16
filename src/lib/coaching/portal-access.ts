import {
  normalizeHrId,
  normalizeRole,
  type AccessContext,
} from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

export type EmployeeCoachingPortalMode = "self" | "team";

function isMedicalRepTitle(value: string | null | undefined) {
  return normalizeRole(value) === "Medical Rep";
}

export async function resolveEmployeeCoachingPortalMode(
  access: AccessContext,
): Promise<EmployeeCoachingPortalMode | null> {
  const normalizedRole = normalizeRole(access.role);
  if (
    normalizedRole === "District Manager" ||
    normalizedRole === "Regional Sales Manager" ||
    normalizedRole === "National Sales Manager" ||
    normalizedRole === "Training Manager"
  ) {
    return "team";
  }

  if (normalizedRole === "Medical Rep") {
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
