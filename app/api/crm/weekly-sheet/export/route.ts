import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadWeeklySheet } from "@/lib/crm/weekly-sheet";
import { buildWeeklySheetWorkbook } from "@/lib/crm/weekly-sheet-workbook";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { readsRegionalTeamReports, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Weekly Sheet as Excel — the Regional Sales Manager's only (owner, 2026-11-08). The gate is asked here,
 * before any read: a signed-in person without Phoenix CRM, or without a regional sales manager's seat, gets a 403.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }
    if (!(await canAccess(access, "phoenix_crm", "read"))) {
      return NextResponse.json({ error: "forbidden", message: "The Weekly Sheet is for the Regional Sales Manager." }, { status: 403 });
    }
    const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
    if (!viewer || !readsRegionalTeamReports(viewer)) {
      return NextResponse.json({ error: "forbidden", message: "The Weekly Sheet is for the Regional Sales Manager." }, { status: 403 });
    }
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:crm:weekly-sheet" });

    const week = new URL(request.url).searchParams.get("week");
    const sheet = await loadWeeklySheet(viewer, isIsoDay(week) ? week : null);
    const buffer = await buildWeeklySheetWorkbook(sheet, new Date().toISOString());

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "crm_weekly_sheet_export",
      entityId: null,
      summary: `Exported the Weekly Sheet (${sheet.label}, ${sheet.districts.reduce((sum, district) => sum + district.reps.length, 0)} reps)`,
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="weekly-sheet-${sheet.weekStart}.xlsx"`,
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
    return NextResponse.json({ error: "export_failed", message: clientSafeErrorMessage(error, "The Weekly Sheet could not be exported.") }, { status: 500 });
  }
}
