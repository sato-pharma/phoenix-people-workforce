import { redirect } from "next/navigation";

import { AttendancePolicyCard } from "@/components/attendance/attendance-policy-card";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { FingerprintAnalytics, type FingerprintTarget } from "@/components/employee-portal/fingerprint-analytics";
import { getEmployeeAttendanceData, loadAttendanceDirectReports } from "@/lib/attendance/employee-attendance";
import { loadAttendancePolicyExplainer } from "@/lib/attendance/policy-explainer-loader";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export default async function FingerprintAnalyticsPage() {
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

  // The policy the signed-in employee is actually judged by. Null — and the card is
  // simply not rendered — for anyone not subject to fingerprint tracking, so nobody is
  // shown a deduction rule that is never applied to them.
  const policyExplainer = await loadAttendancePolicyExplainer(hrId);

  // Managers may also view their direct reports' reports. The first target is
  // always the signed-in user; reports are appended only when they exist.
  let directReports: Awaited<ReturnType<typeof loadAttendanceDirectReports>> = [];
  try {
    directReports = await loadAttendanceDirectReports(hrId);
  } catch {
    directReports = [];
  }
  const targets: FingerprintTarget[] = [
    { hrId, label: "My report", sublabel: "You", isSelf: true },
    ...directReports.map((report) => ({
      hrId: report.hrId,
      label: report.fullName,
      sublabel: report.jobTitle || "Direct report",
      isSelf: false,
    })),
  ];

  if (!initialData) {
    initialData = {
      dateFrom,
      dateTo,
      pendingDisputes: 0,
      policyDetails: [],
      rows: [],
      summary: {
        absentDays: 0,
        completeDays: 0,
        deductionDays: 0,
        exceptionDays: 0,
        lateDays: 0,
        shortDays: 0,
        totalRows: 0,
      },
    };
  }

  return (
    <EmployeePortalPageShell
      badge="My Attendance"
      description="Your complete punch history — filter by date range and export a formatted Excel report."
      title="Fingerprint Analytics"
    >
      {initialError && (
        <p className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {initialError}
        </p>
      )}
      {policyExplainer && (
        <div className="mb-5">
          <AttendancePolicyCard explainer={policyExplainer} />
        </div>
      )}
      <FingerprintAnalytics hrId={hrId} initialData={initialData} targets={targets} />
    </EmployeePortalPageShell>
  );
}
