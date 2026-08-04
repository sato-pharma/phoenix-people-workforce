import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  describeDirectOrderReportFilters,
  filterDirectOrderReportRows,
  parseDirectOrderReportFilters,
} from "@/lib/direct-orders/report-filters";
import { buildDirectOrdersReportWorkbook } from "@/lib/direct-orders/report-workbook";
import { getDirectOrderReport, resolveDirectOrderReportScope } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SCOPE_LABEL: Record<string, string> = {
  all: "All direct orders (company-wide)",
  hierarchy: "Your region / management line",
  own: "Your own direct orders",
};

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertExportRateLimit({ actor: access.hrId, request, scope: "direct-orders-report" });

    // Re-load server-side (never trust the client) and scope by the viewer's role.
    const visibleRows = await getDirectOrderReport(access);
    // The body carries the reader's status chips and search box — their SLICE, never their data
    // and never their permissions (the role scope above already decided what may be loaded).
    // Applying it here is what keeps the workbook's row count and money totals equal to the
    // Rows / Pending / Total value / Approved value cards they were looking at; the same
    // filterDirectOrderReportRows runs on both screens.
    const filters = parseDirectOrderReportFilters(await request.json().catch(() => ({})));
    const rows = filterDirectOrderReportRows(visibleRows, filters);
    const filterNote = describeDirectOrderReportFilters(filters);
    const scope = resolveDirectOrderReportScope(access);
    const exportId = randomUUID();
    const generatedAtCairo = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Cairo",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date());

    const scopeLabel = SCOPE_LABEL[scope] ?? scope;

    const buffer = await buildDirectOrdersReportWorkbook(rows, {
      generatedByName: access.hrId ?? "unknown",
      generatedByHrId: access.hrId ?? "unknown",
      // The cover's scope line is where the file explains itself, so the filter stamp belongs
      // beside the visibility scope: a workbook that quietly holds a slice is indistinguishable
      // from a company-wide one once it has been forwarded on.
      scopeLabel: filterNote ? `${scopeLabel}. ${filterNote}` : scopeLabel,
      generatedAtCairo,
      exportId,
    });

    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityType: "direct_order_request",
      entityId: exportId,
      // Both counts are logged: a support question about a forwarded file is answerable only if
      // the trail says how much the reader could see as well as how much they took.
      newValues: {
        exportedRows: rows.length,
        filterSearch: filters.search,
        filterStatuses: filters.statuses,
        scope,
        visibleRows: visibleRows.length,
      },
      summary: `Direct orders report exported (${rows.length} of ${visibleRows.length} rows, scope ${scope}) by ${access.hrId ?? "unknown"}.`,
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="direct-orders-report.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many exports — please wait a minute.", success: false },
        { status: 429 },
      );
    }
    const apiError = toApiError(error, "Could not export the direct orders report.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
