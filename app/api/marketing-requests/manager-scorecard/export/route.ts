import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canUseEmployeePortalMarketingRoiTracking } from "@/lib/employee-portal/navigation";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { clientSafeErrorMessage, forbiddenError } from "@/lib/http/api-errors";
import { canAccessMarketingAdminPage } from "@/lib/marketing-requests/admin-page-access";
import {
  buildMarketingManagerScorecardPdf,
  buildMarketingManagerScorecardWorkbook,
  marketingManagerScorecardFilename,
} from "@/lib/marketing-requests/manager-scorecard-export";
import { getMarketingManagerScorecard } from "@/lib/marketing-requests/manager-scorecard-service";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Excel and PDF of the Manager Scorecard (owner, 2026-10-09: "make me able to extract reports from
 * it either by excel or either by pdf").
 *
 * 🔴 THE DOOR IS THE SAME UNION AS THE REPORT'S OWN GET, not a third role set. An export that a
 * reader cannot open on screen is a data leak with a filename, and an export refused to a reader
 * who can see the page is a bug report. Scope itself is resolved inside the loader, so the file
 * holds exactly the rows its reader would have seen — never the company set.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const mayRead =
      canAccessMarketingAdminPage(access.role, { allowCompanyOversight: true }) ||
      canUseEmployeePortalMarketingRoiTracking(access.role);
    if (!mayRead) throw forbiddenError("You do not have access to the Marketing Manager Scorecard.");

    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:marketing:manager-scorecard",
    });

    const format = new URL(request.url).searchParams.get("format") === "pdf" ? "pdf" : "xlsx";
    const scorecard = await getMarketingManagerScorecard(access);

    if (format === "pdf") {
      const pdf = await buildMarketingManagerScorecardPdf(scorecard);
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          ...DOWNLOAD_NO_STORE_HEADERS,
          "Content-Disposition": `attachment; filename="${marketingManagerScorecardFilename(scorecard.generatedAtIso, "pdf")}"`,
          "Content-Type": "application/pdf",
        },
      });
    }

    const workbook = await buildMarketingManagerScorecardWorkbook(scorecard);
    const buffer = await workbook.xlsx.writeBuffer();
    return new NextResponse(buffer instanceof ArrayBuffer ? buffer : Buffer.from(buffer), {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="${marketingManagerScorecardFilename(scorecard.generatedAtIso, "xlsx")}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to the Marketing Manager Scorecard." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        error: "marketing_manager_scorecard_export_failed",
        message: clientSafeErrorMessage(error, "The Manager Scorecard export failed."),
      },
      { status: 500 },
    );
  }
}
