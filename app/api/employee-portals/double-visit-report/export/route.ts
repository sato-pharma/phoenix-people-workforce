import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  ALL,
  filterLogRows,
  filterNeverVisitedRows,
  filterProbationRows,
} from "@/lib/double-visit-analytics/report-filters";
import { buildDoubleVisitReportPdf, type DoubleVisitReportPdfTab } from "@/lib/double-visit-analytics/report-pdf";
import { buildDoubleVisitReportExportWorkbook, getDoubleVisitReportData } from "@/lib/double-visit-analytics/service";
import { DV_FOCUS_ROLES } from "@/lib/employee-portal/home-snapshot";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function stringParam(url: URL, key: string) {
  const value = url.searchParams.get(key);
  return value && value.trim().length > 0 ? value : ALL;
}

function tabParam(url: URL): DoubleVisitReportPdfTab {
  const value = url.searchParams.get("tab");
  return value === "neverVisited" || value === "probation" ? value : "log";
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!DV_FOCUS_ROLES.has(access.role)) {
      throw new Error("Forbidden: the Double Visit Report is not available for this role.");
    }
    await assertPermission(access, "double_visit_analytics", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:employee-portal:double-visit-report",
    });

    const url = new URL(request.url);
    const format = url.searchParams.get("format") === "pdf" ? "pdf" : "xlsx";
    const tab = tabParam(url);

    const logFilters = {
      areaFilter: stringParam(url, "areaFilter"),
      periodFilter: stringParam(url, "periodFilter"),
      regionFilter: stringParam(url, "regionFilter"),
      roleFilter: stringParam(url, "roleFilter"),
      search: url.searchParams.get("search") ?? "",
      visitKindFilter: stringParam(url, "visitKindFilter"),
      visitorFilter: stringParam(url, "visitorFilter"),
    };
    const neverVisitedFilters = {
      areaFilter: logFilters.areaFilter,
      flaggedOnly: url.searchParams.get("flaggedOnly") === "true",
      search: logFilters.search,
    };
    const probationFilters: { dvStatusFilter: "ALL" | "done" | "pending"; search: string } = {
      dvStatusFilter: stringParam(url, "dvStatusFilter") as "ALL" | "done" | "pending",
      search: logFilters.search,
    };

    const data = await getDoubleVisitReportData({
      access,
      dateFrom: url.searchParams.get("dateFrom"),
      dateTo: url.searchParams.get("dateTo"),
    });

    const filtered = {
      logRows: filterLogRows(data.rows, logFilters),
      neverVisitedRows: filterNeverVisitedRows(data.neverVisited, neverVisitedFilters),
      probationRows: filterProbationRows(data.probation, probationFilters),
    };

    // Human-readable record of what was active when this file was generated — shown on both
    // the xlsx Executive Summary sheet and the pdf summary page.
    const activeFilters: Record<string, string> = {};
    if (logFilters.search) activeFilters.Search = logFilters.search;
    if (logFilters.areaFilter !== ALL) activeFilters.Area = logFilters.areaFilter;
    if (logFilters.regionFilter !== ALL) activeFilters.Region = logFilters.regionFilter;
    if (logFilters.roleFilter !== ALL) activeFilters["Job Title"] = logFilters.roleFilter;
    if (logFilters.visitorFilter !== ALL) activeFilters["Double Visitor"] = logFilters.visitorFilter;
    if (logFilters.visitKindFilter !== ALL) activeFilters.Type = logFilters.visitKindFilter;
    if (logFilters.periodFilter !== ALL) activeFilters.Period = logFilters.periodFilter;
    if (neverVisitedFilters.flaggedOnly) activeFilters["Overdue Only"] = "Yes";
    if (probationFilters.dvStatusFilter !== ALL) activeFilters["DV Status"] = probationFilters.dvStatusFilter;

    if (format === "pdf") {
      const buffer = await buildDoubleVisitReportPdf(data, filtered, activeFilters, tab);
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          ...DOWNLOAD_NO_STORE_HEADERS,
          "Content-Disposition": `attachment; filename="double-visit-report-${data.dateFrom}-to-${data.dateTo}.pdf"`,
          "Content-Type": "application/pdf",
        },
      });
    }

    const workbook = await buildDoubleVisitReportExportWorkbook(data, filtered, activeFilters);
    const buffer = await workbook.xlsx.writeBuffer();
    const body = buffer instanceof ArrayBuffer ? buffer : Buffer.from(buffer);
    return new NextResponse(body, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="double-visit-report-${data.dateFrom}-to-${data.dateTo}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to export the Double Visit Report." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        error: "double_visit_report_export_failed",
        message: clientSafeErrorMessage(error, "Double Visit Report export failed."),
      },
      { status: 500 },
    );
  }
}
