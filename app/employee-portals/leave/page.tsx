import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { EmployeeLeaveWorkspace } from "@/components/leave/leave-workspaces";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeeLeaveWorkspace } from "@/lib/leave/service";
import type { LeaveRequestFilters } from "@/lib/leave/types";

export const dynamic = "force-dynamic";

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseFilters(searchParams: Record<string, string | string[] | undefined>): LeaveRequestFilters {
  const month = firstValue(searchParams.month);
  const year = firstValue(searchParams.year);
  return {
    area: firstValue(searchParams.area),
    employee: firstValue(searchParams.employee),
    employeeHrId: firstValue(searchParams.employeeHrId),
    endDate: firstValue(searchParams.endDate),
    leaveTypeId: firstValue(searchParams.leaveTypeId),
    line: firstValue(searchParams.line),
    managerHrId: firstValue(searchParams.managerHrId),
    month: month ? Number(month) : undefined,
    paymentStatus: firstValue(searchParams.paymentStatus),
    startDate: firstValue(searchParams.startDate),
    status: firstValue(searchParams.status),
    year: year ? Number(year) : undefined,
  };
}

export default async function EmployeeLeavePage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/leave");
  }

  if (!(await canAccess(access, "leave", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to view leave records."
        title="Leave Access Unavailable"
      />
    );
  }

  const searchParams = await props.searchParams;
  const section = firstValue(searchParams.section);
  const viewMode = section === "reports" ? "reports" : "request";
  let data = null;
  try {
    data = await getEmployeeLeaveWorkspace(access, parseFilters(searchParams));
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Leave data is temporarily unavailable. Please try again in a moment."
        title="Leave Workspace Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge={viewMode === "reports" ? "Vacation Reports" : "Vacation Request"}
      description={
        viewMode === "reports"
          ? "Review your vacation history and approved, pending, or rejected leave records."
          : "Review your leave balance, submit a vacation request, and track your request history."
      }
      title={viewMode === "reports" ? "My Vacation Reports" : "Vacation Request"}
    >
      <EmployeeLeaveWorkspace
        {...data}
        defaultVacationTab={viewMode === "reports" ? "my" : "request"}
        key={viewMode === "reports" ? "employee-leave-reports" : "employee-leave-request"}
        viewMode={viewMode}
      />
    </EmployeePortalPageShell>
  );
}
