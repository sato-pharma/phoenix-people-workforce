import { redirect } from "next/navigation";
import { Activity } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CompanyActivityReportTable } from "@/components/company-activity-report/company-activity-report-table";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canReadCompanyActivityReport } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  companyActivityFilterParams,
  COMPANY_ACTIVITY_REPORT_APPLIED_PARAM,
  filterCompanyActivityEmployees,
  isCompanyActivityReportApplied,
  parseCompanyActivityFilters,
} from "@/lib/company-activity-report/filters";
import { getCompanyActivityReportFilterOptions } from "@/lib/company-activity-report/options";
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

/** Next hands multi-valued params as arrays. Collapsing to the first entry gives the same answer a
 * URLSearchParams `.get()` would, which is what the export route reads — the two sides must not
 * disagree about what a repeated key means. */
function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first != null) params.set(key, first);
  }
  return params;
}

export default async function AdminCompanyActivityReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!canReadCompanyActivityReport(access)) redirect(resolveLandingPathForRole(access.role));

  const params = toSearchParams(await searchParams);
  // The range and the filters are both the URL, not constants: the panel writes them and this
  // re-queries. Resolved through the shared helpers so a hand-typed or forwarded link cannot hand
  // the database a date or filter the picker itself could never produce.
  const { endDate, startDate } = resolveCompanyActivityReportRange(
    { endDate: params.get("endDate"), startDate: params.get("startDate") },
    todayIso(),
  );
  const filters = parseCompanyActivityFilters(params);
  const applied = isCompanyActivityReportApplied(params);

  const [options, roster] = await Promise.all([
    getCompanyActivityReportFilterOptions(),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);
  const employees = filterCompanyActivityEmployees(roster, filters);

  // The expensive read — CRM visits, attendance punches and leave requests across every filtered
  // employee, for every day in range — runs ONLY once the reader has actually asked for something.
  // Same "empty until Apply" gate the Company Vacation Report uses, with more reason: this scan
  // touches four data sources per employee-day, not one.
  const report = applied
    ? await getCompanyActivityReport({ employees, endDate, startDate })
    : { days: [], endDate, startDate, summaries: [], unmappedCrmVisitCount: null };

  // Remount the panel on every applied query — see the identical pattern (and the comment
  // explaining why a `key` replaces a state-syncing effect) in the Company Vacation Report's page.
  const appliedKey = (() => {
    const key = companyActivityReportRangeParams({ endDate, startDate });
    for (const [name, value] of companyActivityFilterParams(filters)) key.set(name, value);
    if (applied) key.set(COMPANY_ACTIVITY_REPORT_APPLIED_PARAM, "1");
    return key.toString();
  })();

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="HR Reporting"
        title="Company Activity Report"
        description="Day-by-day CRM visits, office attendance and leave for any employee slice and date range — not a payroll report. Filter first: the report shows only what you ask for."
        icon={<Activity className="h-3.5 w-3.5" />}
      />
      <CompanyActivityReportTable
        key={appliedKey}
        applied={applied}
        endDate={endDate}
        filters={filters}
        options={options}
        report={report}
        startDate={startDate}
      />
    </div>
  );
}
