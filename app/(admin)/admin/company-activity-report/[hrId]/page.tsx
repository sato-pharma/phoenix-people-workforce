import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Activity, ArrowLeft } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { EmployeeDayDetailView } from "@/components/company-activity-report/employee-day-detail-view";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canReadCompanyActivityReport } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  companyActivityFilterParams,
  COMPANY_ACTIVITY_REPORT_APPLIED_PARAM,
  parseCompanyActivityFilters,
} from "@/lib/company-activity-report/filters";
import {
  companyActivityReportRangeParams,
  resolveCompanyActivityReportRange,
} from "@/lib/company-activity-report/range";
import { getCompanyActivityReport } from "@/lib/company-activity-report/service";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

export const dynamic = "force-dynamic";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Same collapsing rule as the summary page — a repeated query key must resolve identically on
 * both, or a forwarded link would show one thing here and another back on the summary. */
function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first != null) params.set(key, first);
  }
  return params;
}

export default async function AdminCompanyActivityReportEmployeePage({
  params,
  searchParams,
}: {
  params: Promise<{ hrId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!canReadCompanyActivityReport(access)) redirect(resolveLandingPathForRole(access.role));

  const { hrId: rawHrId } = await params;
  const hrId = decodeURIComponent(rawHrId);

  const urlParams = toSearchParams(await searchParams);
  // Same resolver + same defaults as the summary page, so a direct link (no query at all) lands on
  // the same month-to-date window rather than inventing a second default somewhere.
  const { endDate, startDate } = resolveCompanyActivityReportRange(
    { endDate: urlParams.get("endDate"), startDate: urlParams.get("startDate") },
    todayIso(),
  );
  // Only used to rebuild the "Back" link below — this page never re-filters the roster, it was
  // already told exactly which one person to load via the route segment.
  const filters = parseCompanyActivityFilters(urlParams);

  const roster = await getEmployeeDirectoryRows({ includeInactive: true });
  const employee = roster.find((row) => row.hrId === hrId);
  if (!employee) notFound();

  const report = await getCompanyActivityReport({ employees: [employee], endDate, startDate });
  const summary = report.summaries[0] ?? null;

  const backParams = companyActivityReportRangeParams({ endDate, startDate });
  for (const [key, value] of companyActivityFilterParams(filters)) backParams.set(key, value);
  // Landing back on the summary page should show results immediately, not the empty "nothing
  // loaded yet" gate the reader already got past once.
  backParams.set(COMPANY_ACTIVITY_REPORT_APPLIED_PARAM, "1");
  const backHref = `/admin/company-activity-report?${backParams.toString()}`;

  return (
    <div className="space-y-5">
      <Link
        className="inline-flex items-center gap-1.5 whitespace-nowrap text-phx-sm font-bold text-slate-500 transition hover:text-orange-600"
        href={backHref}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Company Activity Report
      </Link>
      <AdminPageHero
        description={`${employee.hrId} · ${[employee.jobTitle, employee.lineName, employee.areaName].filter(Boolean).join(" · ") || "No org identity on file"}`}
        eyebrow="HR Reporting · Day by Day"
        icon={<Activity className="h-3.5 w-3.5" />}
        title={employee.displayName}
      />
      <EmployeeDayDetailView
        days={report.days}
        employee={employee}
        endDate={endDate}
        startDate={startDate}
        summary={summary}
      />
    </div>
  );
}
