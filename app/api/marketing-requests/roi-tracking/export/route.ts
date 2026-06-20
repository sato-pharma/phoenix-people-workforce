import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { buildMarketingRoiReportWorkbook } from "@/lib/export/marketing-roi-workbook";
import {
  getMarketingRoiReport,
  loadMarketingRoiExportDetail,
  parseRoiFilterState,
  writeMarketingRoiExportAudit,
} from "@/lib/marketing-requests/roi-report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function exportApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { code: "forbidden", message: error instanceof Error ? error.message : "Forbidden.", status: 403 };
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
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
    const exportId = randomUUID();
    const exportedBy = access.hrId ?? access.loginId ?? "system";
    const buffer = await buildMarketingRoiReportWorkbook({
      report,
      detail,
      meta: { exportedByName: exportedBy, exportedByHrId: exportedBy, role: access.role, exportId, generatedAtIso },
    });

    await writeMarketingRoiExportAudit({
      access,
      exportId,
      kind: "report",
      filterJson: filters as unknown as Record<string, unknown>,
      rowCount: report.rows.length,
      includedRestricted: report.includedRestricted,
      sheets: ["Cover", "Requests", "Products", "Target Pharmacies", "Approvals"],
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
    const { code, message, status } = exportApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
