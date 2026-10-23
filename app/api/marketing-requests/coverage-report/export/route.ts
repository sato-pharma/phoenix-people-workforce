import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, isStatementTimeoutError, STATEMENT_TIMEOUT_API_ERROR, toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { buildMarketingCoverageReportWorkbook } from "@/lib/export/marketing-coverage-workbook";
import {
  getMarketingCoverageReport,
  loadMarketingCoverageExportSalesDetail,
  parseMarketingCoverageFilterState,
} from "@/lib/marketing-requests/coverage-report-service";
import { loadMarketingRoiExportDetail, resolveMarketingExporterName, writeMarketingRoiExportAudit } from "@/lib/marketing-requests/roi-report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function exportApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { code: "forbidden", message: clientSafeErrorMessage(error, "Forbidden."), status: 403 };
  }
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
    return { code: "marketing_coverage_report_schema_not_ready", message: "Marketing Coverage Report schema is not applied to the connected database yet.", status: 503 };
  }
  const apiError = toApiError(error, "Marketing Coverage Report export failed.");
  return { code: apiError.code === "internal_error" ? "marketing_coverage_export_failed" : apiError.code, message: apiError.message, status: apiError.status };
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:marketing:coverage-report" });
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const filters = parseMarketingCoverageFilterState(body && typeof body === "object" ? (body as { filters?: unknown }).filters ?? body : {});
    const generatedAtIso = new Date().toISOString();
    const report = await getMarketingCoverageReport(access, filters, generatedAtIso);
    const requestRefs = report.rows.map((row) => ({ requestId: row.requestId, requestCode: row.requestCode }));
    const [detail, salesDetail] = await Promise.all([
      loadMarketingRoiExportDetail(requestRefs, report.includedRestricted),
      loadMarketingCoverageExportSalesDetail(requestRefs, report.includedRestricted),
    ]);
    const exportId = randomUUID();
    const exportedBy = access.hrId ?? access.loginId ?? "system";
    const buffer = await buildMarketingCoverageReportWorkbook({
      report,
      detail,
      salesDetail,
      meta: { exportedByName: await resolveMarketingExporterName(access), exportedByHrId: exportedBy, role: access.role, exportId, generatedAtIso },
    });

    await writeMarketingRoiExportAudit({
      access,
      exportId,
      kind: "coverage_report",
      filterJson: filters as unknown as Record<string, unknown>,
      rowCount: report.rows.length,
      includedRestricted: report.includedRestricted,
      sheets: ["Cover", "Requests", "Target Pharmacies", "Sales Detail"],
      salesDataAsOf: report.kpi.salesDataAsOf,
    });

    const stamp = generatedAtIso.slice(0, 10);
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="phoenix-marketing-coverage-report-${stamp}.xlsx"`,
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
