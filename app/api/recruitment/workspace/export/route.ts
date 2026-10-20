import { NextResponse } from "next/server";

import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { forbiddenError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { buildWorkspaceWorkbook, workspaceExportFilename } from "@/lib/recruitment/workspace/export-workbook";
import { parseWorkspaceFilters } from "@/lib/recruitment/workspace/filters";
import { workspaceViewer } from "@/lib/recruitment/workspace/role-tabs";
import { loadWorkspaceRowsForExport, viewedTab, WORKSPACE_EXPORT_DEFAULT_MAX } from "@/lib/recruitment/workspace/rows-db";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { trustedOriginForRedirect } from "@/lib/security/origins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The recruitment workspace's current view, as an Excel workbook.
//
// TWO GATES, BOTH REQUIRED. `recruitment: export` is the grant every recruitment file carries (the CV
// lifecycle sheet, the job-post render), so taking CVs off the system stays a deliberate permission —
// the CEO, who READS the workspace through its own named gate, holds no export and gets a 403. Then
// the workspace's own rule (`workspaceViewer`) decides which tabs this person may see and whether the
// Talent Acquisition fence applies; both are applied INSIDE the database filter by
// `loadWorkspaceRowsForExport`, from the session, never from the query string. A tab in the query the
// viewer may not see simply exports nothing.
//
// THE QUERY STRING IS THE SCREEN'S OWN FILTERS (`serializeWorkspaceFilters`), so the file answers the
// same question the page was showing when the button was pressed. The opened-CV parameter is ignored.
//
// A CEILING, SAID OUT LOUD. One more row than the ceiling is read; when it comes back the file holds
// the ceiling and says so under the table, rather than quietly stopping at a round number.
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "export");
    const viewer = workspaceViewer(access);
    if (!viewer.canRead) throw forbiddenError("Forbidden: the recruitment workspace is not open to this account.");
    await assertExportRateLimit({
      actor: access.hrId ?? access.loginId,
      request,
      scope: "export:recruitment:workspace",
    });

    const filters = { ...parseWorkspaceFilters(new URL(request.url).searchParams), candidate: null };
    const ceiling = WORKSPACE_EXPORT_DEFAULT_MAX;
    const read = await loadWorkspaceRowsForExport(filters, viewer, { max: ceiling + 1 });
    const truncated = read.length > ceiling;
    const rows = truncated ? read.slice(0, ceiling) : read;
    const tab = viewedTab(filters, viewer);
    const generatedAtIso = new Date().toISOString();

    const buffer = await buildWorkspaceWorkbook({
      filters,
      generatedAtIso,
      // From the trusted-origin list, never a header as sent, so a link in the file cannot be pointed
      // at another host.
      origin: trustedOriginForRedirect(request),
      rows,
      tab,
      truncatedAt: truncated ? ceiling : null,
    });

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${workspaceExportFilename(tab, generatedAtIso)}"`,
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
    return recruitmentApiError(error, "Could not export the CVs.");
  }
}
