import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, isStatementTimeoutError, STATEMENT_TIMEOUT_API_ERROR, toApiError } from "@/lib/http/api-errors";
import { getMarketingCoverageReport, parseMarketingCoverageFilterState } from "@/lib/marketing-requests/coverage-report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Let the function OUTLIVE the attribution RPC's 45s DB statement_timeout, mirroring the
// sibling roi-tracking route this report reuses internals from.
export const maxDuration = 60;

function marketingCoverageReportApiError(error: unknown) {
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
    normalized.includes("could not find the table") ||
    normalized.includes("could not find the function") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return {
      code: "marketing_coverage_report_schema_not_ready",
      message: "Marketing Coverage Report schema is not applied to the connected database yet.",
      status: 503,
    };
  }

  const apiError = toApiError(error, "Marketing Coverage Report failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_coverage_report_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

// Coverage Report results: role-scoped, filtered report + premium KPI band.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const filters = parseMarketingCoverageFilterState(body && typeof body === "object" ? (body as { filters?: unknown }).filters ?? body : {});
    const report = await getMarketingCoverageReport(access, filters, new Date().toISOString());
    return NextResponse.json(report);
  } catch (error) {
    const { code, message, status } = marketingCoverageReportApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
