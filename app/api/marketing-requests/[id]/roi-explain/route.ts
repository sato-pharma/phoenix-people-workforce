import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, toApiError } from "@/lib/http/api-errors";
import { explainMarketingRequestRoi } from "@/lib/marketing-requests/roi-explain-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only ROI explainability for a single marketing request. GET only — no mutation.
function roiExplainApiError(error: unknown) {
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
      code: "marketing_roi_explain_schema_not_ready",
      message: "The ROI explainability data is not available on the connected database yet.",
      status: 503,
    };
  }
  const apiError = toApiError(error, "ROI explain failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_roi_explain_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const report = await explainMarketingRequestRoi(access, id, new Date().toISOString());
    return NextResponse.json(report);
  } catch (error) {
    const { code, message, status } = roiExplainApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
