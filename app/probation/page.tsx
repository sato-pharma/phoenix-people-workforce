import { AppShell } from "@/components/layout/app-shell";
import { ProbationTracker } from "@/components/probation/probation-tracker";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  employeeDirectoryErrorMessage,
  getEmployeeDirectoryRows,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import type { ProbationRow } from "@/lib/probation/types";

export const dynamic = "force-dynamic";

const probationDays = 90;

function probationPageError(error: unknown) {
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

function addDays(value: string | null, days: number) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysRemaining(value: string) {
  if (!value) return 0;
  const end = new Date(`${value}T00:00:00`).getTime();
  if (Number.isNaN(end)) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((end - today.getTime()) / 86400000);
}

export default async function ProbationPage() {
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "probation", "read");
  let initialData: ProbationRow[] | null = null;
  let initialError: string | null = null;

  try {
    const rows = await getEmployeeDirectoryRows();
    initialData = rows
      .map((employee) => {
        const probationEndDate = addDays(employee.hireDate, probationDays);

        return {
          area_name: employee.areaName ?? "Unassigned",
          crm_id: employee.crmId ?? "",
          days_remaining: daysRemaining(probationEndDate),
          full_name: employee.fullName,
          hire_date: employee.hireDate ?? "",
          hr_id: employee.hrId,
          job_title: employee.positionTitle ?? employee.jobTitle ?? "Unassigned",
          line_name: employee.lineName ?? "Unassigned",
          probation_end_date: probationEndDate,
        };
      })
      .filter((row) => row.days_remaining > 0);
  } catch (error) {
    initialError = probationPageError(error);
  }

  return (
    <AppShell>
      <ProbationTracker
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
