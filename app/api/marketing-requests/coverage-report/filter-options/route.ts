import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, isStatementTimeoutError, STATEMENT_TIMEOUT_API_ERROR, toApiError } from "@/lib/http/api-errors";
import { getMarketingCoverageFilterOptions } from "@/lib/marketing-requests/coverage-report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function filterOptionsApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { code: "forbidden", message: clientSafeErrorMessage(error, "Forbidden."), status: 403 };
  }

  if (isStatementTimeoutError(error)) return { ...STATEMENT_TIMEOUT_API_ERROR };

  const message = errorMessageOf(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("marketing_request") ||
    normalized.includes("source_of_sales") ||
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

  const apiError = toApiError(error, "Marketing Coverage Report filter options failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_coverage_filter_options_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

// Cheap, role-scoped filter options (no ROI math). Returns only dimensions the
// viewer can act on (the "never show a dead filter" rule).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getMarketingCoverageFilterOptions(access));
  } catch (error) {
    const { code, message, status } = filterOptionsApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
