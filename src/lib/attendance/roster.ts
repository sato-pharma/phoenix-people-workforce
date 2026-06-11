import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { isFieldWorkforceFridayOnlyTitle } from "@/lib/field-workforce-compliance/weekend-policy";
import { isIsoDate } from "@/lib/attendance/working-days";

/**
 * Lifecycle statuses that still count as "on the payroll". Mirrors
 * activeLifecycleStatuses in employee-directory.ts (not exported there).
 */
const activeStatuses = new Set(["active", "on_leave"]);

export type AttendanceRosterEmployee = {
  /** Hire date — days before this are not expected (mid-range new hires). */
  activeFromIso: string | null;
  /** Last working date for exited employees — days after this are not expected. */
  activeToIso: string | null;
  department: string;
  employeeName: string;
  hrId: string;
  jobTitle: string;
};

type MappingRow = { employee_hr_id: string | null };

type EmployeeRow = {
  department_id: number | null;
  employment_status: string | null;
  full_name: string | null;
  hire_date: string | null;
  hr_id: string;
  job_title: string | null;
  last_working_date: string | null;
};

type DepartmentRow = { id: number; name: string | null };

function normalizeStatus(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * The set of employees attendance is expected from during a date range.
 *
 * Scope rules (each one exists because of a real reporting bug):
 * - Active fingerprint device mapping required — only mapped staff can punch.
 * - Head-office only: medical reps and district managers are field-based and
 *   never punch the office device, even if a stale mapping exists for them.
 * - Resigned/terminated employees are excluded once their last working date is
 *   behind the range (an exited employee must not show as absent forever).
 * - Mid-range joiners/leavers get activeFromIso/activeToIso so callers only
 *   count days inside the employee's actual employment span.
 */
export async function getAttendanceRoster(input: {
  dateFromIso: string;
  dateToIso: string;
}): Promise<AttendanceRosterEmployee[]> {
  const supabase = getSupabaseAdmin();
  const [mappingResult, employeeResult, departmentResult] = await Promise.all([
    supabase
      .from("attendance_device_user_map")
      .select("employee_hr_id")
      .eq("is_active", true)
      .not("employee_hr_id", "is", null),
    supabase
      .from("employees")
      .select("hr_id,full_name,job_title,department_id,employment_status,hire_date,last_working_date"),
    supabase
      .from("departments")
      .select("id,name"),
  ]);

  if (mappingResult.error) throw mappingResult.error;
  if (employeeResult.error) throw employeeResult.error;
  if (departmentResult.error) throw departmentResult.error;

  const employeeMap = new Map<string, EmployeeRow>();
  for (const employee of (employeeResult.data ?? []) as EmployeeRow[]) {
    const hrId = normalizeAttendanceHrId(employee.hr_id);
    if (hrId) employeeMap.set(hrId, employee);
  }
  const departmentMap = new Map<number, string>(
    ((departmentResult.data ?? []) as DepartmentRow[]).map((row) => [row.id, row.name?.trim() ?? ""]),
  );

  const mappedHrIds = Array.from(new Set(
    ((mappingResult.data ?? []) as MappingRow[])
      .map((row) => normalizeAttendanceHrId(row.employee_hr_id))
      .filter((value): value is string => Boolean(value)),
  ));

  const roster: AttendanceRosterEmployee[] = [];

  for (const hrId of mappedHrIds) {
    const employee = employeeMap.get(hrId);
    // A mapping pointing at no employee record is stale — skip it.
    if (!employee) continue;

    const jobTitle = employee.job_title?.trim() ?? "";
    // Field staff (medical reps, district managers) never punch the head-office
    // device; a leftover mapping must not make them show as absent.
    if (isFieldWorkforceFridayOnlyTitle(jobTitle)) continue;

    const status = normalizeStatus(employee.employment_status);
    const isTerminal = status.length > 0 && !activeStatuses.has(status);
    const lastWorkingDate = isIsoDate(employee.last_working_date) ? employee.last_working_date : null;
    if (isTerminal) {
      // Exited before the range starts (or exit date unknown) — not expected at all.
      if (!lastWorkingDate || lastWorkingDate < input.dateFromIso) continue;
    }

    const hireDate = isIsoDate(employee.hire_date) ? employee.hire_date : null;
    // Hired after the range ends — not expected yet.
    if (hireDate && hireDate > input.dateToIso) continue;

    roster.push({
      activeFromIso: hireDate,
      activeToIso: isTerminal ? lastWorkingDate : null,
      department: typeof employee.department_id === "number"
        ? departmentMap.get(employee.department_id) ?? ""
        : "",
      employeeName: employee.full_name?.trim() || hrId,
      hrId,
      jobTitle,
    });
  }

  return roster;
}

/** True when the date falls inside the employee's employment span. */
export function isWithinEmploymentSpan(employee: AttendanceRosterEmployee, dateIso: string): boolean {
  if (employee.activeFromIso && dateIso < employee.activeFromIso) return false;
  if (employee.activeToIso && dateIso > employee.activeToIso) return false;
  return true;
}
