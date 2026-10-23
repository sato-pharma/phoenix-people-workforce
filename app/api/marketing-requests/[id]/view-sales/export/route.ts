import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { buildMarketingRoiViewSalesWorkbook } from "@/lib/export/marketing-roi-workbook";
import { getMarketingRequestViewSales, resolveMarketingExporterName, writeMarketingRoiExportAudit } from "@/lib/marketing-requests/roi-report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function exportApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { code: "forbidden", message: clientSafeErrorMessage(error, "Forbidden."), status: 403 };
  }
  const message = errorMessageOf(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("marketing_request_not_found")) {
    return { code: "not_found", message: "Marketing request was not found.", status: 404 };
  }
  if (
    normalized.includes("phx_marketing_request_view_sales") ||
    normalized.includes("marketing_roi_distributor_rollup") ||
    normalized.includes("could not find the function") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return { code: "marketing_roi_view_sales_schema_not_ready", message: "The View Sales function is not applied to the connected database yet.", status: 503 };
  }
  const apiError = toApiError(error, "View Sales export failed.");
  return { code: apiError.code === "internal_error" ? "marketing_roi_view_sales_export_failed" : apiError.code, message: apiError.message, status: apiError.status };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:marketing:view-sales" });
    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const generatedAtIso = new Date().toISOString();
    const data = await getMarketingRequestViewSales(access, id, from, to, generatedAtIso);

    const exportId = randomUUID();
    const exportedBy = access.hrId ?? access.loginId ?? "system";
    const buffer = await buildMarketingRoiViewSalesWorkbook({
      data,
      meta: { exportedByName: await resolveMarketingExporterName(access), exportedByHrId: exportedBy, role: access.role, exportId, generatedAtIso },
    });

    await writeMarketingRoiExportAudit({
      access,
      exportId,
      kind: "request",
      requestId: id,
      filterJson: { from: data.range.from, to: data.range.to, isCustom: data.range.isCustom },
      rowCount: data.rows.length,
      includedRestricted: data.includedRestricted,
      sheets: ["Cover", "Matched Sales", "By Product", "By Pharmacy", "By Month"],
      salesDataAsOf: data.salesDataAsOf,
    });

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="phoenix-roi-view-sales-${data.context.requestCode}.xlsx"`,
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
