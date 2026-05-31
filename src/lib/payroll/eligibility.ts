import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";

/**
 * Pure payroll read-view eligibility rule.
 *
 * Payroll dashboards and exports must EXCLUDE employees who are either terminal
 * in their lifecycle (resigned / terminated / inactive / not_renewed / …) or
 * explicitly flagged payroll-ineligible. This predicate is the single source of
 * truth for that exclusion and is dependency-light (only the canonical terminal-
 * status check) so it is trivially unit-testable.
 */

export type PayrollEligibilitySubject = {
  employmentStatus?: string | null;
  payrollEligible?: boolean | null;
};

/** True when the employee must be excluded from payroll read views. */
export function isPayrollIneligibleEmployee(employee: PayrollEligibilitySubject): boolean {
  return isTerminalEmploymentStatus(employee.employmentStatus) || employee.payrollEligible === false;
}
