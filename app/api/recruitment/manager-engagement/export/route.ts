import { NextResponse } from "next/server";
import { fenceManagerEngagementReport } from "@/lib/recruitment/workspace/fence";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import {
  canViewManagerCvEngagement,
  loadManagerCvEngagement,
  resolveManagerEngagementViewerName,
} from "@/lib/recruitment/manager-cv-engagement";
import { filterManagerEngagementRows } from "@/lib/recruitment/manager-engagement-presentation";
import {
  buildManagerEngagementWorkbook,
  managerEngagementExportFilename,
} from "@/lib/recruitment/manager-engagement-workbook";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The silent manager-engagement report, as a workbook.
//
// THE BOUNDARY IS THE REPORT'S OWN AUDIENCE, not a permission resource — canViewManagerCvEngagement,
// exactly as the two page twins and the CV-preview routes next door. Whoever may read the report on
// screen may take it away as a file, and nobody else. The scoping is not re-implemented here either:
// loadManagerCvEngagement already narrows a National Sales Manager to his own line, so the sheet a
// viewer gets is the report he could already see, in the same rows.
//
// STILL SILENT. This reads the report and never touches a CV file, so no `ats_candidate_views` row is
// written and the export cannot inflate the "opened" number it is reporting on. That is the whole
// invariant of this module — see the header of manager-cv-engagement.ts.
//
// GET, and the screen's filter travels on the query string, so the file answers the same question the
// page was showing when the button was pressed. `q` is the manager search box, verbatim; the cover
// sheet names it either way, including when it is empty.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!canViewManagerCvEngagement(access)) {
      return NextResponse.json(
        { error: "forbidden", message: "This report is not available to you.", success: false },
        { status: 403 },
      );
    }
    await assertExportRateLimit({
      actor: access.hrId ?? access.loginId,
      request,
      scope: "export:recruitment:manager-engagement",
    });

    const query = new URL(request.url).searchParams.get("q") ?? "";
    const generatedAtIso = new Date().toISOString();
    const [everyone, exportedBy] = await Promise.all([
      loadManagerCvEngagement(access),
      resolveManagerEngagementViewerName(access),
    ]);
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is neither listed nor counted.
    const report = await fenceManagerEngagementReport(access, everyone);
    const rows = filterManagerEngagementRows(report.rows, query);

    const buffer = await buildManagerEngagementWorkbook({
      report: { ...report, rows },
      meta: { exportedBy, filterQuery: query, generatedAtIso, role: access.role },
    });

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${managerEngagementExportFilename(generatedAtIso)}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message, success: false },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return recruitmentApiError(error, "Manager CV Engagement export failed.");
  }
}
