import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { readsAnyTeamReport, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadTeamVisitsReport } from "@/lib/phoenix-crm/server/team-visits";
import { buildTeamVisitsWorkbook, teamVisitsWorkbookFileName } from "@/lib/phoenix-crm/server/team-visits-workbook";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Visits — Yesterday and Today as Excel — a Regional Sales Manager's or a District Manager's own team only, as the screen is (owner, 2026-11-08;
 * the export came with the premium pass of 9 Nov 2026). The gate is asked here, before any read: a signed-in person
 * without Phoenix CRM, or without a regional sales manager's seat, gets a 403. The loader asks the same gate again.
 * The file holds every rep, whatever the screen's filter.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }
    if (!(await canAccess(access, "phoenix_crm", "read"))) {
      return NextResponse.json({ error: "forbidden", message: "Visits — Yesterday and Today is for a Regional Sales Manager, a District Manager or the Super Admin." }, { status: 403 });
    }
    const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
    if (!viewer || !readsAnyTeamReport(viewer)) {
      return NextResponse.json({ error: "forbidden", message: "Visits — Yesterday and Today is for a Regional Sales Manager, a District Manager or the Super Admin." }, { status: 403 });
    }
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:crm:team-visits" });

    const report = await loadTeamVisitsReport(viewer);
    const buffer = await buildTeamVisitsWorkbook(report, new Date().toISOString());

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "crm_team_visits_export",
      entityId: null,
      summary: `Exported Visits — Yesterday and Today (${report.yesterday} and ${report.today}, ${report.districts.reduce((sum, district) => sum + district.reps.length, 0)} rep seats)`,
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${teamVisitsWorkbookFileName(report)}"`,
        "cache-control": "no-store",
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
      return NextResponse.json({ error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden") }, { status: 403 });
    }
    return NextResponse.json({ error: "export_failed", message: clientSafeErrorMessage(error, "Visits — Yesterday and Today could not be exported.") }, { status: 500 });
  }
}
