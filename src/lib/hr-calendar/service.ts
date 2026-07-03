import {
  employeeDirectoryErrorMessage,
  getEmployeeDirectoryRows,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import type { HrCalendarEmployee } from "@/lib/hr-calendar/types";

export function hrCalendarErrorMessage(error: unknown) {
  if (isEmployeeDirectoryTimeout(error)) {
    return "Supabase request timed out. Check your connection and try again.";
  }

  if (isEmployeeDirectoryEnvMissing(error)) {
    return "Supabase environment variables are missing.";
  }

  if (isEmployeeDirectorySchemaMissing(error)) {
    return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in Supabase SQL editor.";
  }

  return employeeDirectoryErrorMessage(error);
}

export async function getHrCalendarData(): Promise<HrCalendarEmployee[]> {
  const rows = await getEmployeeDirectoryRows();

  return rows.map((employee) => ({
    areaName: employee.areaName ?? "Unassigned",
    birthDate: employee.birthDate ?? "",
    fullName: employee.displayName,
    hireDate: employee.hireDate ?? "",
    hrId: employee.hrId,
    jobTitle: employee.positionTitle ?? employee.jobTitle ?? "Unassigned",
    lineName: employee.lineName ?? "Unassigned",
    managerName: employee.managerName ?? "Unassigned",
    workEmail: employee.workEmail,
  }));
}
