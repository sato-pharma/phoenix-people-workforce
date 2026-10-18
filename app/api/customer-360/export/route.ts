import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildCustomer360Workbook } from "@/lib/customer-360/export/customer-360-workbook";
import { filterHubRows, hubListFiltersFromParams, sortHubRows } from "@/lib/customer-360/list";
import { hubListRow } from "@/lib/customer-360/list-row";
import { loadCustomer360Report } from "@/lib/customer-360/server/report";
import { resolveMarketingExporterName } from "@/lib/marketing-requests/roi-report-service";
import { toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Customer 360's Excel file. GET, so the screen's Export link works as a plain download; it mutates
 * nothing. The gate is here (`sales:read`, as the page), the report is the viewer's own scoped one,
 * and the rows go through `filterHubRows` — the same function the screen runs — so the file holds
 * exactly the customers on screen.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:customer-360" });

    const filters = hubListFiltersFromParams(new URL(request.url).searchParams);
    const [report, generatedBy] = await Promise.all([loadCustomer360Report(access), resolveMarketingExporterName(access)]);
    const rows = sortHubRows(filterHubRows(report.hubs.map((hub) => hubListRow(hub, report.lastMonths)), filters));
    const generatedAt = new Date().toISOString();
    const buffer = await buildCustomer360Workbook({
      builtAt: report.builtAt,
      closedMonths: report.months.all,
      distributorNames: report.distributorNames,
      filters,
      generatedAt,
      generatedBy,
      hubs: report.hubs,
      lastMonths: report.lastMonths,
      moneyVisible: report.moneyVisible,
      rows,
    });

    return new NextResponse(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="customer-360-${filters.kind === "doctor" ? "doctors" : "accounts"}-${generatedAt.slice(0, 10)}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      status: 200,
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json({ error: "rate_limited", message: "Too many exports. Try again shortly.", success: false }, { status: 429 });
    }
    const apiError = toApiError(error, "Customer 360 export failed.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json({ error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false }, { status });
  }
}
