import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, isStatementTimeoutError, STATEMENT_TIMEOUT_API_ERROR, toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { buildMarketingRoiReportWorkbook, type BulkMatchedSalesLine } from "@/lib/export/marketing-roi-workbook";
import {
  getMarketingRequestViewSales,
  getMarketingRoiReport,
  loadMarketingRoiExportDetail,
  parseRoiFilterState,
  resolveMarketingExporterName,
  writeMarketingRoiExportAudit,
} from "@/lib/marketing-requests/roi-report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function exportApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { code: "forbidden", message: clientSafeErrorMessage(error, "Forbidden."), status: 403 };
  }
  // A DB statement timeout (SQLSTATE 57014) is transient + user-actionable, not an internal fault.
  if (isStatementTimeoutError(error)) return { ...STATEMENT_TIMEOUT_API_ERROR };
  const message = errorMessageOf(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("phx_marketing_request_roi_actuals") ||
    normalized.includes("marketing_roi_distributor_rollup") ||
    normalized.includes("could not find the function") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return { code: "marketing_roi_tracking_schema_not_ready", message: "Marketing ROI tracking schema is not applied to the connected database yet.", status: 503 };
  }
  const apiError = toApiError(error, "Marketing ROI export failed.");
  return { code: apiError.code === "internal_error" ? "marketing_roi_export_failed" : apiError.code, message: apiError.message, status: apiError.status };
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:marketing:roi-tracking" });
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const filters = parseRoiFilterState(body && typeof body === "object" ? (body as { filters?: unknown }).filters ?? body : {});
    const generatedAtIso = new Date().toISOString();
    const report = await getMarketingRoiReport(access, filters, generatedAtIso);
    const detail = await loadMarketingRoiExportDetail(
      report.rows.map((row) => ({ requestId: row.requestId, requestCode: row.requestCode })),
      report.includedRestricted,
    );
    // Bulk line-level matched sales — the SAME authoritative View Sales source as the per-request
    // receipt, gathered per request (bounded concurrency + a hard cap so a huge report can't blow
    // the 60s budget). Best-effort per request: one failure never sinks the whole export.
    const MATCHED_SALES_REQUEST_CAP = 300;
    const matchedSales: BulkMatchedSalesLine[] = [];
    const cappedRows = report.rows.slice(0, MATCHED_SALES_REQUEST_CAP);
    for (let i = 0; i < cappedRows.length; i += 8) {
      const batchResults = await Promise.all(
        cappedRows.slice(i, i + 8).map(async (row) => {
          try {
            const vs = await getMarketingRequestViewSales(access, row.requestId, null, null, generatedAtIso);
            return vs.rows.map((r) => ({
              requestCode: row.requestCode,
              invoicePeriod: r.invoicePeriod,
              distributorName: r.distributorName,
              productName: r.productName,
              customerCode: r.customerCode,
              customerName: r.customerName ?? null,
              regionName: r.regionName ?? null,
              qty: r.qty,
              value: r.value,
            })) as BulkMatchedSalesLine[];
          } catch {
            return [] as BulkMatchedSalesLine[]; // one request failing must not sink the bulk export
          }
        }),
      );
      for (const rows of batchResults) matchedSales.push(...rows);
    }

    const exportId = randomUUID();
    const exportedBy = access.hrId ?? access.loginId ?? "system";
    const buffer = await buildMarketingRoiReportWorkbook({
      report,
      detail,
      matchedSales,
      meta: { exportedByName: await resolveMarketingExporterName(access), exportedByHrId: exportedBy, role: access.role, exportId, generatedAtIso },
    });

    await writeMarketingRoiExportAudit({
      access,
      exportId,
      kind: "report",
      filterJson: filters as unknown as Record<string, unknown>,
      rowCount: report.rows.length,
      includedRestricted: report.includedRestricted,
      sheets: ["Cover", "Requests", "Products", "Target Pharmacies", "Approvals", "Matched Sales"],
      salesDataAsOf: report.kpi.salesDataAsOf,
    });

    const stamp = generatedAtIso.slice(0, 10);
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="phoenix-marketing-roi-${stamp}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    const { code, message, status } = exportApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
