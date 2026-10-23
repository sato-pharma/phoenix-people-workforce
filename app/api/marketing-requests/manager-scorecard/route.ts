import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canUseEmployeePortalMarketingRoiTracking } from "@/lib/employee-portal/navigation";
import { clientSafeErrorMessage, errorMessageOf, forbiddenError, isStatementTimeoutError, STATEMENT_TIMEOUT_API_ERROR, toApiError } from "@/lib/http/api-errors";
import { canAccessMarketingAdminPage } from "@/lib/marketing-requests/admin-page-access";
import { getMarketingManagerScorecard } from "@/lib/marketing-requests/manager-scorecard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function scorecardApiError(error: unknown) {
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
      code: "marketing_manager_scorecard_schema_not_ready",
      message: "Marketing ROI schema is not applied to the connected database yet.",
      status: 503,
    };
  }

  const apiError = toApiError(error, "Marketing Manager Scorecard failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_manager_scorecard_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

/**
 * The Manager Scorecard — one row per person who raised marketing requests, scoped to the viewer.
 *
 * The door is the UNION of the two pages that mount it: the admin-shell ROI gate
 * (assertMarketingAdminPageAccess({ allowCompanyOversight: true })) and the portal ROI Tracker's
 * own predicate. Deliberately not a third role set — the scorecard is the ROI report grouped by
 * person, same data and same audience, and a set of its own would drift away from both of them.
 *
 * WHICH rows come back is never decided here: getMarketingRoiReport resolves the viewer's scope
 * (company-wide for the oversight roles, the hierarchy subtree for a manager, own seat plus his own
 * area AND line for a Medical Rep). This route widens nothing.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const mayRead =
      canAccessMarketingAdminPage(access.role, { allowCompanyOversight: true }) ||
      canUseEmployeePortalMarketingRoiTracking(access.role);
    if (!mayRead) throw forbiddenError("You do not have access to the Marketing Manager Scorecard.");

    return NextResponse.json(await getMarketingManagerScorecard(access));
  } catch (error) {
    const { code, message, status } = scorecardApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
