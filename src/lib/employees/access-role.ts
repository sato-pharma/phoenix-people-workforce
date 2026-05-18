import { normalizeRole, type PhoenixRole } from "@/lib/auth/permissions";

export type EmployeeAccessRoleInput = {
  jobTitle?: string | null;
  positionTitle?: string | null;
};

export function resolveEmployeeAccessRole(employee: EmployeeAccessRoleInput): PhoenixRole {
  const jobRole = normalizeRole(employee.jobTitle);
  if (jobRole !== "Employee") return jobRole;

  const positionRole = normalizeRole(employee.positionTitle);
  if (positionRole !== "Employee") return positionRole;

  return "Employee";
}
