import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { FingerprintAnalytics } from "@/components/employee-portal/fingerprint-analytics";
import { PremiumHero } from "@/components/ui/premium-hero";
import { getEmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
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

  if (!initialData) {
    initialData = {
      dateFrom,
      dateTo,
      pendingDisputes: 0,
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
      description="Your complete punch history — filter by date range and export a formatted Excel report."
      hero={
        <PremiumHero
          badge={
            <span className="inline-flex items-center gap-1.5 rounded border border-orange-400/30 bg-orange-500/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-orange-300">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-400 ep-pulse-orange" />
              Live Data
            </span>
          }
          kicker="My Attendance"
          subtitle="Your complete punch history. Filter by date range, review your status per day, and export a formatted Excel report."
          title="Fingerprint Analytics"
        />
      }
      title="Fingerprint Analytics"
    >
      {initialError && (
        <p className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {initialError}
        </p>
      )}
      <FingerprintAnalytics hrId={hrId} initialData={initialData} />
    </EmployeePortalPageShell>
  );
}
