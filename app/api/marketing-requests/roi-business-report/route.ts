import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, isStatementTimeoutError, STATEMENT_TIMEOUT_API_ERROR, toApiError } from "@/lib/http/api-errors";
import { getMarketingRoiBusinessOptions, getMarketingRoiBusinessRows, getMarketingRoiCohorts } from "@/lib/marketing-requests/roi-business-report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Mirrors the sibling roi-tracking route: let the function outlive the attribution RPC's 45s
// DB statement_timeout so a slow query returns a clean 503 rather than being killed at the edge.
export const maxDuration = 60;

// Read-only business-friendly ROI report (browse by requester / by customer). GET only — no
// mutation, no new attribution logic; composes the existing ROI report + Explain ROI services.
function marketingRoiBusinessReportApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { code: "forbidden", message: clientSafeErrorMessage(error, "Forbidden."), status: 403 };
  }
  if (isStatementTimeoutError(error)) return { ...STATEMENT_TIMEOUT_API_ERROR };

  const message = errorMessageOf(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("marketing_request") ||
    normalized.includes("source_of_sales") ||
    normalized.includes("phx_marketing_request_roi_actuals") ||
    normalized.includes("phx_marketing_request_view_sales") ||
    normalized.includes("could not find the table") ||
    normalized.includes("could not find the function") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return {
      code: "marketing_roi_business_report_schema_not_ready",
      message: "Marketing ROI report schema is not applied to the connected database yet.",
      status: 503,
    };
  }

  const apiError = toApiError(error, "Marketing ROI report failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_roi_business_report_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const groupBy = url.searchParams.get("groupBy");
    const value = url.searchParams.get("value");

    if (!groupBy) {
      const options = await getMarketingRoiBusinessOptions(access);
      return NextResponse.json(options);
    }

    if (groupBy === "cohorts") {
      return NextResponse.json(await getMarketingRoiCohorts(access));
    }

    if (groupBy !== "requester" && groupBy !== "customer") {
      return NextResponse.json({ error: "invalid_request", message: "groupBy must be \"requester\" or \"customer\"." }, { status: 400 });
    }
    const trimmedValue = String(value ?? "").trim();
    if (!trimmedValue) {
      return NextResponse.json({ error: "invalid_request", message: "value is required with groupBy." }, { status: 400 });
    }

    const result = groupBy === "requester"
      ? await getMarketingRoiBusinessRows(access, { by: "requester", hrId: trimmedValue })
      : await getMarketingRoiBusinessRows(access, { by: "customer", name: trimmedValue });
    return NextResponse.json(result);
  } catch (error) {
    const { code, message, status } = marketingRoiBusinessReportApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
