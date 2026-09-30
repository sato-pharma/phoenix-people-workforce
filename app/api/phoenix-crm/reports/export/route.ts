import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { readsTeamReports, reportIncludesTest, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadBrickCoverageReport } from "@/lib/phoenix-crm/server/brick-report";
import { loadAdoptionReport } from "@/lib/phoenix-crm/server/adoption";
import { loadDailyPlanReport } from "@/lib/phoenix-crm/server/daily-plan-report";
import { loadExceptionsBoard } from "@/lib/phoenix-crm/server/exceptions";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { buildPhoenixCrmReportsWorkbook } from "@/lib/phoenix-crm/server/reports-workbook";
import {
  loadCoverageReport,
  loadManagerReport,
  loadPlanReport,
  loadReportScope,
  loadVisitLocationReport,
  loadVisitsReport,
  type ReportFilterInput,
} from "@/lib/phoenix-crm/server/reports";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Seven sections, several of them fanning out over a line's months. The default 15 s is not enough
// for a national scope, and a truncated workbook is worse than a slow one.
export const maxDuration = 60;

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * GET = the whole reports pack as one workbook, in the house identity.
 *
 * 🔴 **WHICH SHEETS EXIST IS THE ACCESS CONTROL, and it is decided here.** A section the viewer may
 * not read is never loaded and is handed to the builder as `null`, which writes no sheet. An empty
 * "Where the visit was saved" tab would tell a medical rep both that the report exists and that he is
 * not trusted with it — the disclosure Golden Rule #1 forbids, only in a file he keeps. The two
 * manager-only sections are gated by `readsTeamReports`, the same predicate their own services use,
 * so the workbook can never be a way around a screen's refusal.
 *
 * The rate limit runs BEFORE any load: seven sections is a heavy read, and a limiter that fires after
 * the work has been done has protected nothing.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:phoenix-crm:reports" });

    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const filters: ReportFilterInput = {
      seatId: search.get("seatId"),
      lineCode: search.get("lineCode"),
      includeTest: search.get("includeTest"),
      from: search.get("from"),
      to: search.get("to"),
      month: search.get("month"),
      compare: search.get("compare"),
    };
    const includeTest = reportIncludesTest(viewer, search.get("includeTest"));
    const managerSections = readsTeamReports(viewer);
    // The daily plan keeps its own days — they reach forward, which the shared period refuses — so it
    // travels as two parameters of its own. Without them it writes no sheet.
    const dailyFrom = search.get("dailyFrom");
    const dailyTo = search.get("dailyTo");

    // Loaded together; each service applies the viewer's scope again. `managers` is asked for even
    // when the viewer has none — the service answers with an empty list, and a manager sheet with no
    // rows is a real finding, unlike a section the viewer may not read at all.
    const [names, scope, visits, plan, coverage, managers, locations, exceptions, bricks, adoption, daily] = await Promise.all([
      // The cover says who it was prepared for, by NAME — the owner's standing rule, and a saved
      // workbook is exactly the artefact where an HR code would outlive anyone who could decode it.
      loadPeopleNames([viewer.hrId]),
      loadReportScope(viewer),
      loadVisitsReport(viewer, filters),
      loadPlanReport(viewer, filters),
      loadCoverageReport(viewer, filters),
      loadManagerReport(viewer, filters),
      managerSections ? loadVisitLocationReport(viewer, filters) : Promise.resolve(null),
      managerSections ? loadExceptionsBoard(viewer, { test: filters.includeTest }) : Promise.resolve(null),
      managerSections ? loadBrickCoverageReport(viewer, filters) : Promise.resolve(null),
      managerSections ? loadAdoptionReport(viewer, { test: filters.includeTest }) : Promise.resolve(null),
      // Every viewer's, as on the screen: a rep's own plan is his to keep. It reads ONE territory and
      // answers with none when several are in reach and none is chosen — that writes no sheet.
      dailyFrom && dailyTo ? loadDailyPlanReport(viewer, { ...filters, from: dailyFrom, to: dailyTo }) : Promise.resolve(null),
    ]);
    const dailyPlan = daily?.territory ? daily : null;

    const chosenLine = scope.lines.find((line) => line.lineCode === filters.lineCode)?.lineName ?? null;
    const chosenTerritory = scope.territories.find((territory) => territory.seatId === filters.seatId)?.name ?? null;

    const buffer = await buildPhoenixCrmReportsWorkbook({
      adoption,
      bricks,
      coverage,
      dailyPlan,
      exceptions,
      generatedAtIso: new Date().toISOString(),
      includeTest,
      locations,
      managers,
      periodText:
        `${visits.period.from} to ${visits.period.to} · coverage for ${coverage.month.month}`
        + (dailyPlan ? ` · daily plan ${dailyPlan.period.from} to ${dailyPlan.period.to}` : ""),
      plan,
      scopeText: [chosenTerritory, chosenLine, `${scope.territories.length} territories in scope`]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
      viewerName: nameOf(names, viewer.hrId),
      visits,
    });

    // A workbook naming individual employees and their work leaves the building, so the fact that it
    // was taken is recorded — including WHICH sheets it held, since that is what it discloses.
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: null,
      entityType: "phoenix_crm_reports_export",
      summary:
        `Exported the Phoenix CRM reports pack (${visits.period.from} to ${visits.period.to}, `
        + `${scope.territories.length} territories, manager sections ${managerSections ? "included" : "withheld"}, `
        + `daily plan ${dailyPlan ? `of ${dailyPlan.territory?.name} ${dailyPlan.period.from} to ${dailyPlan.period.to}` : "not included"})`,
    });

    const filename = `phoenix-crm-reports-${visits.period.from}-to-${visits.period.to}.xlsx`;
    return new NextResponse(buffer as unknown as ArrayBuffer, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${filename}"`,
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
    return phoenixCrmFailure(error, "Could not build the reports workbook.");
  }
}
