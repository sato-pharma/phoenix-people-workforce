import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, isStatementTimeoutError, STATEMENT_TIMEOUT_API_ERROR, toApiError } from "@/lib/http/api-errors";
import { getMarketingRoiReport, parseRoiFilterState } from "@/lib/marketing-requests/roi-report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Let the function OUTLIVE the attribution RPC's 45s DB statement_timeout so a slow query returns a
// clean 503 ("narrow your filters") rather than being killed at the platform edge. Mirrors the
// sibling roi-tracking/export route (app/api/marketing-requests/** had no per-route maxDuration).
export const maxDuration = 60;

function marketingRoiTrackingApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return {
      code: "forbidden",
      message: clientSafeErrorMessage(error, "Forbidden."),
      status: 403,
    };
  }

  // A DB statement timeout (SQLSTATE 57014) is transient + user-actionable, not an internal fault.
  if (isStatementTimeoutError(error)) return { ...STATEMENT_TIMEOUT_API_ERROR };

  const message = errorMessageOf(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("marketing_request") ||
    normalized.includes("source_of_sales") ||
    normalized.includes("phx_marketing_request_roi_actuals") ||
    normalized.includes("could not find the table") ||
    normalized.includes("could not find the function") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return {
      code: "marketing_roi_tracking_schema_not_ready",
      message: "Marketing ROI tracking schema is not applied to the connected database yet.",
      status: 503,
    };
  }

  const apiError = toApiError(error, "Marketing ROI tracking failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_roi_tracking_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

// Filter-Engine results: role-scoped, filtered ROI report + executive KPI band.
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
    const report = await getMarketingRoiReport(access, filters, new Date().toISOString());
    return NextResponse.json(report);
  } catch (error) {
    const { code, message, status } = marketingRoiTrackingApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
