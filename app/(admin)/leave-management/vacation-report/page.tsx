import { VacationReport } from "@/components/vacation/vacation-report";
import { isForbiddenError, resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getVacationReportData,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";
import type { VacationReportFilters } from "@/lib/vacation/types";

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function filtersFromSearchParams(searchParams: Record<string, string | string[] | undefined>): VacationReportFilters {
  return {
    dateFrom: firstParam(searchParams.dateFrom),
    dateTo: firstParam(searchParams.dateTo),
    department: firstParam(searchParams.department),
    employee: firstParam(searchParams.employee),
    line: firstParam(searchParams.line),
    manager: firstParam(searchParams.manager),
    paymentStatus: firstParam(searchParams.paymentStatus) as VacationReportFilters["paymentStatus"],
    requestId: firstParam(searchParams.requestId),
    search: firstParam(searchParams.search),
    status: firstParam(searchParams.status) as VacationReportFilters["status"],
    vacationType: firstParam(searchParams.vacationType) as VacationReportFilters["vacationType"],
  };
}

function vacationReportPageError(error: unknown) {
  if (isVacationSchemaMissing(error)) {
    return "Vacation schema is not ready. Apply the new v2 vacation migration before using this module.";
  }
  if (isForbiddenError(error)) {
    return vacationErrorMessage(error);
  }
  return vacationErrorMessage(error) || "Unable to load vacation report.";
}

export default async function VacationReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  const filters = filtersFromSearchParams(await searchParams);
  let initialData: Awaited<ReturnType<typeof getVacationReportData>> | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getVacationReportData(access, filters);
  } catch (error) {
    initialError = vacationReportPageError(error);
  }

  // The (admin) group layout redirects every portal-mode viewer to /employee-portals before this
  // page runs, so navigation mode is ALWAYS "admin" here. A second branch wrapping this in
  // EmployeePortalPageShell lived below until 2026-08-30 and could not execute: it was written for
  // a reader the layout had already sent away. Portal viewers have their own page at
  // /employee-portals/vacation-report, which is what their sidebar links and what the twin of this file
  // forwards an admin-mode viewer back from. The group layout's own comment used to name
  // leave-management as living OUTSIDE the group; it does not, and that note is corrected there.
  return <VacationReport initialData={initialData} initialError={initialError} />;
}
