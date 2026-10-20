import { redirect } from "next/navigation";

import { AttendancePolicyCard } from "@/components/attendance/attendance-policy-card";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { FingerprintAnalytics, type FingerprintTarget } from "@/components/employee-portal/fingerprint-analytics";
import { getEmployeeAttendanceData, loadAttendancePickerReports } from "@/lib/attendance/employee-attendance";
import { loadAttendancePolicyExplainer } from "@/lib/attendance/policy-explainer-loader";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { addDaysToDateOnly } from "@/lib/date-only";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

export default async function FingerprintAnalyticsPage() {
  const access = await resolveAccessContextFromPage();

  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }

  const hrId = access.hrId;
  if (!hrId) {
    redirect("/employee-portals");
  }

  // The Cairo calendar day, not the server's UTC one — the same window My Attendance loads.
  const dateTo = currentCairoDateOnlyIso();
  const dateFrom = addDaysToDateOnly(dateTo, -30) ?? dateTo;

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

  // Managers may also view their reports' reports — a manager seat his whole subtree, the same
  // people the per-person API admits (loadAttendancePickerReports; owner, 2026-10-20). The first
  // target is always the signed-in user; reports are appended only when they exist.
  let directReports: Awaited<ReturnType<typeof loadAttendancePickerReports>> = [];
  try {
    directReports = await loadAttendancePickerReports(access);
  } catch (error) {
    // Not a banner, and deliberately: the attendance read above already surfaces its own failure
    // through `initialError`, and this one only costs the manager the OTHER names in his picker —
    // his own report still loads. What it must not be is SILENT, which is what it was: a manager
    // with six reports saw a picker holding one entry and no reason why. Logged the way every other
    // best-effort read in this directory is, so the failure exists somewhere a person can read it.
    logPortalFailure(
      {
        route: "/employee-portals/fingerprint-analytics",
        module: "attendance-direct-reports",
        role: access.role,
        hrId,
      },
      error,
    );
    directReports = [];
  }
  const targets: FingerprintTarget[] = [
    { hrId, label: "My report", sublabel: "You", isSelf: true },
    ...directReports.map((report) => ({
      hrId: report.hrId,
      label: report.fullName,
      sublabel: report.jobTitle || "Report",
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
      badge="Leave & HR"
      description="Your full punch history. Pick a range, then download it as an Excel file."
      title="Attendance Analytics"
    >
      {initialError && (
        <p className="border border-rose-200 bg-rose-50 px-4 py-3 text-phx-md font-semibold text-rose-800">
          {initialError}
        </p>
      )}
      {policyExplainer && <AttendancePolicyCard explainer={policyExplainer} />}
      <FingerprintAnalytics hrId={hrId} initialData={initialData} targets={targets} />
    </EmployeePortalPageShell>
  );
}
