/**
 * The employee-context payload the Approvals Hub shows beside a pending request, and the guard
 * that decides whether a response actually carries it.
 *
 * Why the guard exists: `/api/approvals-hub/employee-context` answers 403 to a caller who may
 * approve for an employee but may not read that employee's attendance. The case that crashed was
 * HR Operations, whose scope is "company" rather than "system", on anyone outside its own direct
 * reports; the owner ruled on 2026-09-17 that HR Operations reads any one person's context
 * (canViewEmployeeAttendanceReport), so that 403 is gone, but any other approver without that reach
 * still gets one and the guard stays. The error body is a
 * truthy object (`{ error: "forbidden", message: "Forbidden." }`) with no `attendance` and no
 * arrays, so casting the response blind put it into component state and every `.length` read threw
 * during render. That crashed the whole hub to its error boundary, once per selection: 22 times in
 * 32 seconds in production on 2026-09-15.
 */
export type EmployeeContext = {
  attendance: {
    absentDays: number;
    completeDays: number;
    deductionDays: number;
    exceptionDays: number;
    lateDays: number;
    shortDays: number;
    totalRows: number;
    dateFrom: string;
    dateTo: string;
  };
  recentLeave: Array<{
    endDate: string;
    hrDecision: "approved" | "rejected" | null;
    managerDecision: "approved" | "rejected" | null;
    startDate: string;
    vacationType: string;
  }>;
  recentExcuses: Array<{
    excuseDate: string;
    excuseType: "morning" | "afternoon";
    status: string;
  }>;
};

/** True only for a body carrying every field the context panel reads. */
export function isEmployeeContext(value: unknown): value is EmployeeContext {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<EmployeeContext>;
  return (
    typeof v.attendance === "object" &&
    v.attendance !== null &&
    Array.isArray(v.recentLeave) &&
    Array.isArray(v.recentExcuses)
  );
}
