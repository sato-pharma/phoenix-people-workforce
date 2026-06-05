import type { PhoenixRole } from "@/lib/auth/permissions";

export type EmployeeAccessRoleInput = {
  jobTitle?: string | null;
  positionTitle?: string | null;
};

/**
 * Resolve the *initial* access role for an auto-provisioned employee account.
 *
 * GOVERNANCE — a job title is descriptive only and is NEVER a permission source.
 * Titles such as "HR Manager", "Finance Manager", "District Sales Manager" or
 * "R&D Manager" must not grant any elevated access. Auto-provisioned accounts
 * therefore always start at the least-privilege "Employee" role; the real access
 * role (Manager, HR Specialist, CEO, the sales roles, …) is assigned explicitly
 * on `app_auth_users` by an authorized admin and is what drives the permission
 * matrix and scope.
 *
 * The `_employee` argument (job/position title) is retained for call-site
 * stability and possible future, business-rule-approved explicit mappings, but
 * its title text is intentionally ignored here.
 */
export function resolveEmployeeAccessRole(employee: EmployeeAccessRoleInput): PhoenixRole {
  // Title text is deliberately ignored — it is descriptive only, never a
  // permission source. Every auto-provisioned account starts at the
  // least-privilege Employee role and is elevated explicitly afterwards.
  void employee;
  return "Employee";
}
