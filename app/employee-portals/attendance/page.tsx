import { redirect } from "next/navigation";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { AttendanceOverview } from "@/components/employee-portal/attendance-overview";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { LandingRailLine } from "@/components/employee-portal/landing-kit";
import { getEmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { addDaysToDateOnly } from "@/lib/date-only";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";

export const dynamic = "force-dynamic";

export default async function EmployeeAttendancePage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }

  const hrId = access.hrId;
  if (!hrId) {
    redirect("/employee-portals");
  }

  // The Cairo calendar day, not the server's UTC one: between midnight and 03:00 Cairo the UTC date
  // is still yesterday, which silently dropped the current day from "the last 30 days".
  const dateTo = currentCairoDateOnlyIso();
  const dateFrom = addDaysToDateOnly(dateTo, -30) ?? dateTo;

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
      badge="Leave & HR"
      title="My Attendance"
      description="Your attendance records for the last 30 days. Dispute any record you believe is incorrect."
    >
      {initialError && (
        <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`} role="alert">
          <LandingRailLine rail="bg-rose-600">{initialError}</LandingRailLine>
        </div>
      )}
      <AttendanceOverview hrId={hrId} initialData={initialData} />
    </EmployeePortalPageShell>
  );
}
