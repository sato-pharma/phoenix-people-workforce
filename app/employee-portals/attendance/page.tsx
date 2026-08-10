import { redirect } from "next/navigation";

import { AttendanceOverview } from "@/components/employee-portal/attendance-overview";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { getEmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export default async function EmployeeAttendancePage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }

  const hrId = access.hrId;
  if (!hrId) {
    redirect("/employee-portals");
  }

  const dateTo = dateKey(new Date());
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateFrom = dateKey(thirtyDaysAgo);

  let initialData = null;
  let initialError: string | null = null;
  try {
    initialData = await getEmployeeAttendanceData(hrId, dateFrom, dateTo);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Attendance data failed to load.";
  }

  if (!initialData) {
    initialData = {
      dateFrom,
      dateTo,
      pendingDisputes: 0,
      policyDetails: [],
      rows: [],
      summary: { absentDays: 0, completeDays: 0, deductionDays: 0, exceptionDays: 0, lateDays: 0, shortDays: 0, totalRows: 0 },
    };
  }

  return (
    <EmployeePortalPageShell
      badge="Attendance"
      title="My Attendance"
      description="Your attendance records for the last 30 days. Dispute any record you believe is incorrect."
    >
      {initialError && (
        <p className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {initialError}
        </p>
      )}
      <AttendanceOverview hrId={hrId} initialData={initialData} />
    </EmployeePortalPageShell>
  );
}
