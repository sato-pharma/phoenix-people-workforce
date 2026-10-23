import { redirect } from "next/navigation";

import { EmployeeDayReport } from "@/components/attendance/employee-day-report";
import {
  getEmployeeDayByDayReport,
  getEmployeeDayDeductionDecisions,
  listFlexEligibleEmployees,
  type EmployeeDayDecisionInfo,
} from "@/lib/attendance/employee-day-report";
import { canAccess } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ employeeHrId?: string; dateFrom?: string; dateTo?: string }>;
};

export default async function EmployeeDayReportPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/attendance/employee-day-report");
  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }

  // This report exposes per-employee punch/deduction detail — gate it to Super Admin only,
  // not just the coarse attendance:read permission every basic attendance surface uses
  // (matches the nav entry's own systemAdministratorNavigationRoles restriction).
  if (access.role !== "Super Admin") {
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
  let initialDecisions: Record<string, EmployeeDayDecisionInfo> = {};
  let initialError: string | null = null;
  if (filters?.employeeHrId && filters?.dateFrom && filters?.dateTo) {
    try {
      const [report, decisions] = await Promise.all([
        getEmployeeDayByDayReport({
          dateFromIso: filters.dateFrom,
          dateToIso: filters.dateTo,
          employeeHrId: filters.employeeHrId,
        }),
        getEmployeeDayDeductionDecisions({
          dateFromIso: filters.dateFrom,
          dateToIso: filters.dateTo,
          employeeHrId: filters.employeeHrId,
        }),
      ]);
      initialReport = report;
      initialDecisions = Object.fromEntries(decisions);
    } catch (error) {
      initialError = error instanceof Error ? error.message : "Day-by-day report failed to load.";
    }
  }

  return (
    <EmployeeDayReport
      // Remount on any employee/range change -- this component's decisions/editedDays state is
      // keyed by dateIso only, so without a fresh instance a `router.push` to a different
      // employee (same component, new props) would leak the previous employee's edited values
      // and confirm/reject checkmarks onto the new employee's matching calendar dates.
      key={`${filters?.employeeHrId ?? ""}:${filters?.dateFrom ?? ""}:${filters?.dateTo ?? ""}`}
      employees={employees}
      employeesError={employeesError}
      initialDateFrom={filters?.dateFrom ?? ""}
      initialDateTo={filters?.dateTo ?? ""}
      initialDecisions={initialDecisions}
      initialEmployeeHrId={filters?.employeeHrId ?? ""}
      initialError={initialError}
      initialReport={initialReport}
    />
  );
}
