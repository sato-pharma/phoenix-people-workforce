import { redirect } from "next/navigation";
import { ProbationTracker } from "@/components/probation/probation-tracker";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import {
  assertPermission,
  canSeeEmployee,
  normalizeHrId,
  normalizeLineName,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { addDaysToDateOnly, parseDateOnly } from "@/lib/date-only";
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
  if (isEmployeeDirectoryTimeout(error)) return "Supabase request timed out. Check your connection and try again.";
  if (isEmployeeDirectoryEnvMissing(error)) return "Supabase environment variables are missing.";
  if (isEmployeeDirectorySchemaMissing(error)) return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in Supabase SQL editor.";
  return employeeDirectoryErrorMessage(error);
}

function addDays(value: string | null, days: number) {
  return addDaysToDateOnly(value, days) ?? "";
}

function daysRemaining(value: string) {
  const endDate = parseDateOnly(value);
  if (!endDate) return 0;
  const end = endDate.getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((end - today.getTime()) / 86400000);
}

export default async function EmployeePortalProbationPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  const normalizedRole = access.role.toLowerCase();
  const isDsm = normalizedRole.includes("district manager");
  const isNsm = normalizedRole.includes("national sales manager");
  if (!isDsm && !isNsm) {
    redirect("/employee-portals");
  }

  await assertPermission(access, "probation", "read");
  let initialData: ProbationRow[] | null = null;
  let initialError: string | null = null;

  try {
    const employees = await getEmployeeDirectoryRows();
    const currentHrId = normalizeHrId(access.hrId);
    const currentEmployee = employees.find((employee) => normalizeHrId(employee.hrId) === currentHrId) ?? null;
    const currentLine = normalizeLineName(currentEmployee?.lineName);

    initialData = employees
      .filter((employee) => {
        if (isNsm) return normalizeLineName(employee.lineName) === currentLine;
        return canSeeEmployee(access, employee) && normalizeHrId(employee.hrId) !== currentHrId;
      })
      .map((employee) => {
        const probationEndDate = addDays(employee.hireDate, probationDays);

        return {
          area_name: employee.areaName ?? "Unassigned",
          crm_id: employee.crmId ?? "",
          days_remaining: daysRemaining(probationEndDate),
          employment_status: employee.employmentStatus ?? "",
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

  if (initialError) {
    return (
      <EmployeePortalEmptyState
        message={initialError}
        title="Probation Tracker Unavailable"
      />
    );
  }

  if (!initialData || initialData.length === 0) {
    return (
      <EmployeePortalEmptyState
        message="No active probation records found for your current scope."
        title="Probation Tracker"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      description="Track probation timelines and escalation candidates by area and hierarchy."
      title="Probation Tracker"
    >
      <ProbationTracker initialData={initialData} initialError={initialError} />
    </EmployeePortalPageShell>
  );
}
