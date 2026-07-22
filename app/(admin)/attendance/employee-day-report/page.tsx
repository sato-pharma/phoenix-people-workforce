import { redirect } from "next/navigation";

import { EmployeeDayReport } from "@/components/attendance/employee-day-report";
import { isAuthorizedDisputeReviewer } from "@/lib/attendance/digest-read";
import { getEmployeeDayByDayReport, listFlexEligibleEmployees } from "@/lib/attendance/employee-day-report";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ employeeHrId?: string; dateFrom?: string; dateTo?: string }>;
};

export default async function EmployeeDayReportPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }

  // This report exposes the same per-employee punch/deduction detail as digest-review —
  // gate it the same way (reviewer or Super Admin), not just the coarse attendance:read
  // permission every basic attendance surface uses. Fail closed on a DB/config error.
  const authorized = await isAuthorizedDisputeReviewer(access.hrId, access.role === "Super Admin").catch(() => false);
  if (!authorized) {
    redirect("/employee-portals");
  }

  const filters = await searchParams;
  let employees: Awaited<ReturnType<typeof listFlexEligibleEmployees>> = [];
  let employeesError: string | null = null;
  try {
    // Once an admin has picked a range, scope the dropdown to THAT range so someone who
    // resigned or moved off the flexible-hours model since is still selectable — otherwise
    // defaults to today, which is all that's needed before any range is picked.
    employees = await listFlexEligibleEmployees(
      filters?.dateFrom && filters?.dateTo ? { dateFromIso: filters.dateFrom, dateToIso: filters.dateTo } : undefined,
    );
  } catch (error) {
    employeesError = error instanceof Error ? error.message : "Employee list failed to load.";
  }

  let initialReport: Awaited<ReturnType<typeof getEmployeeDayByDayReport>> | null = null;
  let initialError: string | null = null;
  if (filters?.employeeHrId && filters?.dateFrom && filters?.dateTo) {
    try {
      initialReport = await getEmployeeDayByDayReport({
        dateFromIso: filters.dateFrom,
        dateToIso: filters.dateTo,
        employeeHrId: filters.employeeHrId,
      });
    } catch (error) {
      initialError = error instanceof Error ? error.message : "Day-by-day report failed to load.";
    }
  }

  return (
    <EmployeeDayReport
      employees={employees}
      employeesError={employeesError}
      initialDateFrom={filters?.dateFrom ?? ""}
      initialDateTo={filters?.dateTo ?? ""}
      initialEmployeeHrId={filters?.employeeHrId ?? ""}
      initialError={initialError}
      initialReport={initialReport}
    />
  );
}
