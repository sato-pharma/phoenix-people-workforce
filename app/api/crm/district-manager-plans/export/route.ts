import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { readsRegionalTeamReports, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { buildDistrictPlansWorkbook, districtPlansWorkbookFileName } from "@/lib/phoenix-crm/server/district-plans-workbook";
import { loadDistrictManagersPlans } from "@/lib/phoenix-crm/server/manager-plan-bookings";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * District Managers' Plans as Excel — the Regional Sales Manager's only, as the screen is (owner, 2026-11-08; the
 * export came with the premium pass of 9 Nov 2026). The gate is asked here, before any read: a signed-in person
 * without Phoenix CRM, or without a regional sales manager's seat, gets a 403. The loader asks the same gate again.
 * `week` is any day of the week wanted, read strictly; anything else is the current week. The file holds every seat,
 * whatever the screen's filter.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }
    if (!(await canAccess(access, "phoenix_crm", "read"))) {
      return NextResponse.json({ error: "forbidden", message: "District Managers' Plans is for the Regional Sales Manager." }, { status: 403 });
    }
    const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
    if (!viewer || !readsRegionalTeamReports(viewer)) {
      return NextResponse.json({ error: "forbidden", message: "District Managers' Plans is for the Regional Sales Manager." }, { status: 403 });
    }
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:crm:district-manager-plans" });

    const week = request.nextUrl.searchParams.get("week");
    const report = await loadDistrictManagersPlans(viewer, isIsoDay(week) ? week : viewer.visitDay);
    const buffer = await buildDistrictPlansWorkbook(report, new Date().toISOString());

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "crm_district_plans_export",
      entityId: null,
      summary: `Exported District Managers' Plans (week of ${report.weekStart}, ${report.weeks.length} district manager seats)`,
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${districtPlansWorkbookFileName(report)}"`,
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
    return NextResponse.json({ error: "export_failed", message: clientSafeErrorMessage(error, "District Managers' Plans could not be exported.") }, { status: 500 });
  }
}
