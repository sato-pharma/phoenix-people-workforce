import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, toApiError } from "@/lib/http/api-errors";
import { getMarketingCoverageRequestPharmacies } from "@/lib/marketing-requests/coverage-report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function pharmaciesApiError(error: unknown) {
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
    return {
      code: "marketing_coverage_report_schema_not_ready",
      message: "Marketing Coverage Report schema is not applied to the connected database yet.",
      status: 503,
    };
  }
  const apiError = toApiError(error, "Marketing Coverage Report pharmacy detail failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_coverage_pharmacies_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

// Lazy accordion-expand data: this request's target pharmacies, ALWAYS including
// zero-sales pharmacies (never silently omitted).
export async function GET(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  try {
    const { requestId } = await params;
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const includeRestricted = url.searchParams.get("includeRestricted") === "1";
    const pharmacies = await getMarketingCoverageRequestPharmacies(access, requestId, from, to, new Date().toISOString(), includeRestricted);
    return NextResponse.json({ pharmacies });
  } catch (error) {
    const { code, message, status } = pharmaciesApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
