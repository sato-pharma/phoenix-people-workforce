import { HrCalendar } from "@/components/hr-calendar/hr-calendar";
import { AppShell } from "@/components/layout/app-shell";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  employeeDirectoryErrorMessage,
  getEmployeeDirectoryRows,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import type { HrCalendarEmployee } from "@/lib/hr-calendar/types";

export const dynamic = "force-dynamic";

function calendarPageError(error: unknown) {
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

export default async function HrCalendarPage() {
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "hr_calendar", "read");
  let initialData: HrCalendarEmployee[] | null = null;
  let initialError: string | null = null;

  try {
    const rows = await getEmployeeDirectoryRows();
    initialData = rows.map((employee) => ({
      areaName: employee.areaName ?? "Unassigned",
      birthDate: employee.birthDate ?? "",
      fullName: employee.fullName,
      hireDate: employee.hireDate ?? "",
      hrId: employee.hrId,
      jobTitle: employee.positionTitle ?? employee.jobTitle ?? "Unassigned",
      lineName: employee.lineName ?? "Unassigned",
      managerName: employee.managerName ?? "Unassigned",
      workEmail: employee.workEmail,
    }));
  } catch (error) {
    initialError = calendarPageError(error);
  }

  return (
    <AppShell>
      <HrCalendar
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
