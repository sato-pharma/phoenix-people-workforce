import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, isStatementTimeoutError, STATEMENT_TIMEOUT_API_ERROR, toApiError } from "@/lib/http/api-errors";
import { parseRoiFilterState } from "@/lib/marketing-requests/roi-report-service";
import { getMarketingRoiTracker, type MarketingRequestOrigin } from "@/lib/marketing-requests/roi-tracker-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Same reasoning as the sibling roi-tracking route: outlive the attribution RPC's 45s DB
// statement_timeout so a slow query returns a clean 503 ("narrow your filters") instead of being
// killed at the platform edge.
export const maxDuration = 60;

function roiTrackerApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return {
      code: "forbidden",
      message: clientSafeErrorMessage(error, "Forbidden."),
      status: 403,
    };
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
      code: "marketing_roi_tracker_schema_not_ready",
      message: "Marketing ROI schema is not applied to the connected database yet.",
      status: 503,
    };
  }

  const apiError = toApiError(error, "Marketing ROI tracker failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_roi_tracker_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

/**
 * The complete per-request ROI picture — rows, KPI band, products, target pharmacies (with
 * code-reference quality), and approval chain. Delegates scoping/masking entirely to
 * getMarketingRoiReport via getMarketingRoiTracker; this route adds no access logic of its own.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const filters = parseRoiFilterState(
      body && typeof body === "object" ? (body as { filters?: unknown }).filters ?? body : {},
    );
    // Provenance split: the live tracker reports Phoenix-submitted requests, the Archived module
    // reports the Excel-imported ones. Anything other than an explicit "xlsx_import" means the
    // live module, so a malformed body can never silently surface legacy data in the clean view.
    const rawOrigin = body && typeof body === "object" ? (body as { origin?: unknown }).origin : undefined;
    const origin: MarketingRequestOrigin = rawOrigin === "xlsx_import" ? "xlsx_import" : "phoenix";
    const report = await getMarketingRoiTracker(access, filters, new Date().toISOString(), origin);
    return NextResponse.json(report);
  } catch (error) {
    const { code, message, status } = roiTrackerApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
