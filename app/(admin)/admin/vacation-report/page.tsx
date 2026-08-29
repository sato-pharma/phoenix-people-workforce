import { redirect } from "next/navigation";
import { FileSpreadsheet } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CompanyVacationReportTable } from "@/components/vacation/company-vacation-report-table";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import {
  canApproveCompanyVacationReportRow,
  canReadCompanyVacationReport,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getCompanyVacationReport } from "@/lib/vacation/company-vacation-report";
import {
  companyVacationReportFilterParams,
  filterCompanyVacationReportRows,
  isCompanyVacationReportApplied,
  parseCompanyVacationReportFilters,
  COMPANY_VACATION_REPORT_APPLIED_PARAM,
} from "@/lib/vacation/company-vacation-report-filters";
import { getCompanyVacationReportFilterOptions } from "@/lib/vacation/company-vacation-report-options";
import {
  companyVacationReportRangeParams,
  resolveCompanyVacationReportRange,
} from "@/lib/vacation/company-vacation-report-range";

export const dynamic = "force-dynamic";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Next hands multi-valued params as arrays. Collapsing to the first entry gives the same answer a
 * URLSearchParams `.get()` would, which is what the export route reads — the two sides must not
 * disagree about what `?source=A&source=B` means. */
function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first != null) params.set(key, first);
  }
  return params;
}

export default async function AdminVacationReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  // Two separate questions, deliberately. WHO MAY OPEN this is now Super Admin + SFE Manager
  // (owner request 2026-08-27) + HR Operations (owner ruling 2026-08-29); WHO MAY WRITE from it is
  // still Super Admin alone — HR Operations administers leave, she does not decide it. A reader who
  // fails the first is sent to their own landing page rather than /admin — the SFE Manager's
  // /admin is not his home, and bouncing him somewhere he cannot use reads as a broken link.
  if (!canReadCompanyVacationReport(access)) redirect(resolveLandingPathForRole(access.role));

  const params = toSearchParams(await searchParams);
  // The range and the filter are both the URL, not constants: the panel writes them and this
  // re-queries. Resolved through the shared helper so a hand-typed or forwarded link cannot hand
  // the database a date the picker itself could never produce.
  const { endDate, startDate } = resolveCompanyVacationReportRange(
    { endDate: params.get("endDate"), startDate: params.get("startDate") },
    todayIso(),
  );
  const filters = parseCompanyVacationReportFilters(params);
  const applied = isCompanyVacationReportApplied(params);

  // The expensive read — it scans CRM visits across the whole range — runs ONLY once the reader
  // has actually asked for something (owner instruction 2026-08-27: "the page is empty ... I
  // filter, then what I filtered on appears"). Opening the page costs the dropdown roster and
  // nothing else. The filter is applied HERE rather than in the browser so the screen, the row
  // counter and the export are three renderings of one query instead of three chances to disagree.
  const [options, rows] = await Promise.all([
    getCompanyVacationReportFilterOptions(),
    applied
      ? getCompanyVacationReport({ endDate, startDate }).then((rangeRows) =>
          filterCompanyVacationReportRows(rangeRows, filters))
      : Promise.resolve([]),
  ]);

  const canApprove = canApproveCompanyVacationReportRow(access);

  // Remount the panel on every applied query. The panel holds a DRAFT of the filter, which must
  // not be clobbered while the reader is editing it — but it does have to pick up the new values
  // once a query has run (a removed chip, a preset, a forwarded link). A key does that without a
  // state-syncing effect, and `setState` inside `useEffect` is a lint error in this repo.
  const appliedKey = (() => {
    const key = companyVacationReportRangeParams({ endDate, startDate });
    for (const [name, value] of companyVacationReportFilterParams(filters)) key.set(name, value);
    if (applied) key.set(COMPANY_VACATION_REPORT_APPLIED_PARAM, "1");
    return key.toString();
  })();

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="HR Reporting"
        title="Company Vacation Report"
        description={
          canApprove
            ? "Every employee's leave, org-wide, with a Source column saying where each day came from — Phoenix (submitted here) or CRM (pulled from the field CRM). Filter first: the report shows only what you ask for."
            : "Every employee's leave, org-wide, with a Source column saying where each day came from — Phoenix (submitted here) or CRM (pulled from the field CRM). Read-only: filter, view and export."
        }
        icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
      />
      <CompanyVacationReportTable
        key={appliedKey}
        applied={applied}
        canApprove={canApprove}
        endDate={endDate}
        filters={filters}
        options={options}
        rows={rows}
        startDate={startDate}
      />
    </div>
  );
}
