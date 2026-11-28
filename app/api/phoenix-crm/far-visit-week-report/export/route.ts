import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { parseFarVisitWeekFilter } from "@/lib/phoenix-crm/far-visit-week-rules";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadFarVisitWeekReport } from "@/lib/phoenix-crm/server/far-visit-week-report";
import { buildFarVisitWeekWorkbook } from "@/lib/phoenix-crm/server/far-visit-week-workbook";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// GET = the Far-visit week as one workbook (owner, 28 Nov 2026): sheet "Week" is the screen's grid, sheet
// "Details" every refused or held visit of it. Built from the SAME loader as the screen, so the file can never hold
// a rep the screen would not show this reader; the loader refuses a rep and anybody outside the team reports'
// readers. The rate limit runs before the load, and the taking of the file is recorded, because it names
// employees and where their phones were.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:phoenix-crm:far-visit-week" });

    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    // The same filters the screen was read with: the file holds exactly the rows the reader was looking at.
    const report = await loadFarVisitWeekReport(viewer, search.get("week"), parseFarVisitWeekFilter((name) => search.get(name)));
    const names = await loadPeopleNames([viewer.hrId]);
    const buffer = await buildFarVisitWeekWorkbook(report, nameOf(names, viewer.hrId), new Date().toISOString());

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: null,
      entityType: "phoenix_crm_far_visit_week_export",
      summary: `Exported the Far-visit week ${report.week.start} to ${report.week.end} (${report.totals.reps} reps, ${report.items.length} lines${report.filterLabel ? `; ${report.filterLabel}` : ""})`,
    });

    return new NextResponse(buffer as unknown as ArrayBuffer, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="far-visit-week-${report.week.start}-to-${report.week.end}.xlsx"`,
        "content-type": XLSX,
      },
      status: 200,
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return phoenixCrmFailure(error, "Could not build the far-visit week workbook.");
  }
}
