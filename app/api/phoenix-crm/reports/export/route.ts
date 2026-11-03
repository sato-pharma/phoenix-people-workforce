import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { afterResponse } from "@/lib/http/after-response";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { capacityMonthsOffered } from "@/lib/phoenix-crm/capacity-board";
import { reportFileSlug } from "@/lib/phoenix-crm/report-guide";
import {
  readsCalendar,
  readsFieldHeardByProduct,
  readsPlaceVsActual,
  readsTeamReports,
  reportIncludesTest,
  resolvePhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { loadBrickCoverageReport } from "@/lib/phoenix-crm/server/brick-report";
import { loadAdoptionReport } from "@/lib/phoenix-crm/server/adoption";
import { loadDailyPlanReport } from "@/lib/phoenix-crm/server/daily-plan-report";
import { loadExceptionsBoard } from "@/lib/phoenix-crm/server/exceptions";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadCapacityBoard, loadFieldHeardReport, loadMissingStockReport, loadObjectionsByDoctorReport, loadSamplesReport } from "@/lib/phoenix-crm/server/insight-reports";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { buildPhoenixCrmReportsWorkbook, type ReportsPackInput } from "@/lib/phoenix-crm/server/reports-workbook";
import { loadTeamCalendar } from "@/lib/phoenix-crm/server/team-calendar";
import {
  loadCoverageReport,
  loadCustomerFrequencyReport,
  loadManagerReport,
  loadPlanReport,
  loadReportScope,
  loadTrackingSheetReport,
  loadVisitLocationReport,
  loadVisitsReport,
  type ReportFilterInput,
} from "@/lib/phoenix-crm/server/reports";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Every section at once, several of them fanning out over a line's months. The default 15 s is not
// enough for a national scope, and a truncated workbook is worse than a slow one.
export const maxDuration = 60;

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Every section absent — the starting point of a pack that holds one report and nothing else. */
const NO_SECTIONS: Omit<ReportsPackInput, "viewerName" | "periodText" | "scopeText" | "includeTest" | "generatedAtIso"> = {
  adoption: null,
  bricks: null,
  calendar: null,
  capacity: null,
  coverage: null,
  dailyPlan: null,
  exceptions: null,
  frequency: null,
  heard: null,
  locations: null,
  managers: null,
  objections: null,
  plan: null,
  samples: null,
  stock: null,
  tracking: null,
  visits: null,
};

function xlsxResponse(buffer: Buffer, filename: string): NextResponse {
  return new NextResponse(buffer as unknown as ArrayBuffer, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": XLSX,
    },
    status: 200,
  });
}

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
 * The four insight boards of 2026-10-02 are manager sections too, behind the same predicate. A product
 * or marketing manager — who reads ONE of them, what the field heard about his own products, and has
 * no export button on the screen — gets a pack holding that sheet and nothing else, never an empty tab
 * for each report he has no reach into.
 *
 * The rate limit runs BEFORE any load: every section at once is a heavy read, and a limiter that fires
 * after the work has been done has protected nothing.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    // The limiter and the viewer are read together — neither needs the other — and the limiter's
    // refusal still answers first, exactly as when it ran alone. No section is loaded until both are in.
    const [limit, viewerRead] = await Promise.allSettled([
      assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:phoenix-crm:reports" }),
      resolvePhoenixCrmViewer(access),
    ]);
    if (limit.status === "rejected") throw limit.reason;
    if (viewerRead.status === "rejected") throw viewerRead.reason;
    const viewer = viewerRead.value;
    const search = searchOf(request);
    const filters: ReportFilterInput = {
      seatId: search.get("seatId"),
      lineCode: search.get("lineCode"),
      // The screen's "Manager" filter, so the file holds what the screen held (owner, 2026-10-20).
      managerHrId: search.get("managerHrId"),
      includeTest: search.get("includeTest"),
      from: search.get("from"),
      to: search.get("to"),
      month: search.get("month"),
      compare: search.get("compare"),
    };
    const includeTest = reportIncludesTest(viewer, search.get("includeTest"));
    const managerSections = readsTeamReports(viewer);
    // 🔴 THE PLACE-VS-ACTUAL SHEET HAS ITS OWN AUDIENCE since 2026-10-02 (owner): the district manager,
    // the NSM, SFE and the Super Admin — never the CEO or a regional manager, who still read every other
    // manager section. Behind `managerSections` its service would REFUSE them and fail the whole pack.
    const locationSection = readsPlaceVsActual(viewer);

    // A product or marketing manager reads ONE section (owner, 2026-10-02): what the field heard about
    // his own products, company-wide. His pack is that sheet and its cover; the service narrows it to
    // his products exactly as it does on the screen.
    if (!managerSections && readsFieldHeardByProduct(viewer)) {
      const [ownNames, ownHeard] = await Promise.all([loadPeopleNames([viewer.hrId]), loadFieldHeardReport(viewer, filters)]);
      const heardBuffer = await buildPhoenixCrmReportsWorkbook({
        ...NO_SECTIONS,
        generatedAtIso: new Date().toISOString(),
        heard: ownHeard,
        includeTest,
        periodText: `${ownHeard.period.from} to ${ownHeard.period.to}`,
        scopeText: "Your products, company-wide",
        viewerName: nameOf(ownNames, viewer.hrId),
      });
      await afterResponse("phoenix_crm_reports_export_audit", () =>
        writeAuditLog({
          actorLoginId: access.loginId ?? null,
          entityId: null,
          entityType: "phoenix_crm_reports_export",
          summary: `Exported what the field heard about their own products (${ownHeard.period.from} to ${ownHeard.period.to})`,
        }),
      );
      return xlsxResponse(heardBuffer, `phoenix-crm-${reportFileSlug("heard")}-${ownHeard.period.from}-to-${ownHeard.period.to}.xlsx`);
    }

    // Grade against capacity reads this month or the next — its own month, sent as `capacityMonth`. A
    // month it does not offer (a tab left open into a new month) reads this month rather than failing
    // the whole pack over one sheet.
    const capacityMonth = search.get("capacityMonth");
    const capacityFilters: ReportFilterInput = {
      ...filters,
      month: capacityMonth && capacityMonthsOffered(viewer.cairoToday).includes(capacityMonth) ? capacityMonth : null,
    };
    // The daily plan keeps its own days — they reach forward, which the shared period refuses — so it
    // travels as two parameters of its own. Without them it writes no sheet.
    const dailyFrom = search.get("dailyFrom");
    const dailyTo = search.get("dailyTo");

    // Loaded together; each service applies the viewer's scope again. `managers` is asked for even
    // when the viewer has none — the service answers with an empty list — but it is WRITTEN only when
    // the scope has a manager to show (`scope.hasManagers`), the same gate the screen offers the
    // report behind. A rep's file used to carry a "per manager" sheet with no rows, a report his own
    // tab never shows him (2026-10-29, "the pages is not having any data").
    // 🔴 THE NAMES AND THE ARRAY MUST STAY IN STEP. Two branches appended to this list on the same
    // evening — Wave 2's three and the daily plan — and a resolution that adds a name without its
    // loader in the same position silently hands one report's data to another. Read them together.
    const [
      names,
      scope,
      visits,
      plan,
      coverage,
      managers,
      locations,
      exceptions,
      bricks,
      adoption,
      frequencyRaw,
      trackingRaw,
      calendarRaw,
      daily,
      capacity,
      heard,
      stock,
      samples,
      objections,
    ] = await Promise.all([
      // The cover says who it was prepared for, by NAME — the owner's standing rule, and a saved
      // workbook is exactly the artefact where an HR code would outlive anyone who could decode it.
      loadPeopleNames([viewer.hrId]),
      loadReportScope(viewer),
      loadVisitsReport(viewer, filters),
      loadPlanReport(viewer, filters),
      loadCoverageReport(viewer, filters),
      loadManagerReport(viewer, filters),
      locationSection ? loadVisitLocationReport(viewer, filters) : Promise.resolve(null),
      managerSections ? loadExceptionsBoard(viewer, { test: filters.includeTest }) : Promise.resolve(null),
      managerSections ? loadBrickCoverageReport(viewer, filters) : Promise.resolve(null),
      managerSections ? loadAdoptionReport(viewer, { test: filters.includeTest }) : Promise.resolve(null),
      // Per CUSTOMER, so they answer `needsOneTerritory` unless exactly one was chosen — the route
      // reads `seatId` into `filters` and the tab sends it, so a chosen territory reaches them.
      loadCustomerFrequencyReport(viewer, filters),
      loadTrackingSheetReport(viewer, filters),
      // 🔴 NOT a manager section since 2026-10-01. The owner gave the calendar to the rep as well,
      // scoped to himself, so the workbook follows the screen: gated on the calendar's own
      // predicate, and a rep's sheet holds his own month. Leaving it behind `managerSections`
      // would have downloaded him a workbook missing the one month view he can actually open.
      readsCalendar(viewer) ? loadTeamCalendar(viewer, { month: filters.month, test: filters.includeTest }) : Promise.resolve(null),
      // Every viewer's, as on the screen: a rep's own plan is his to keep. It reads ONE territory and
      // answers with none when several are in reach and none is chosen — that writes no sheet.
      dailyFrom && dailyTo ? loadDailyPlanReport(viewer, { ...filters, from: dailyFrom, to: dailyTo }) : Promise.resolve(null),
      // The four insight boards of 2026-10-02: manager sections like the four above, behind the same
      // predicate their own services refuse a medical rep with — so the file can never hold one the
      // screen would refuse. What the field heard reads the line or the whole scope, never one
      // territory, exactly as on the screen.
      managerSections ? loadCapacityBoard(viewer, capacityFilters) : Promise.resolve(null),
      managerSections ? loadFieldHeardReport(viewer, filters) : Promise.resolve(null),
      managerSections ? loadMissingStockReport(viewer, filters) : Promise.resolve(null),
      managerSections ? loadSamplesReport(viewer, filters) : Promise.resolve(null),
      // Objections by doctor (owner, 2026-11-03): behind the same predicate its service refuses with.
      managerSections ? loadObjectionsByDoctorReport(viewer, filters) : Promise.resolve(null),
    ]);
    const dailyPlan = daily?.territory ? daily : null;

    // 🔴 NO TERRITORY MEANS NO SHEET, NOT AN EMPTY ONE — and the cover then does not promise it.
    // A per-customer sheet for a whole district is thousands of rows nobody asked for, and a tab
    // headed with a report that is not in it is worse than a tab that is absent.
    const frequency = frequencyRaw.needsOneTerritory ? null : frequencyRaw;
    const tracking = trackingRaw.needsOneTerritory ? null : trackingRaw;
    const calendar = calendarRaw && calendarRaw.rows.length > 0 ? calendarRaw : null;

    const chosenLine = scope.lines.find((line) => line.lineCode === filters.lineCode)?.lineName ?? null;
    const chosenTerritory = scope.territories.find((territory) => territory.seatId === filters.seatId)?.name ?? null;
    const chosenManagerEntry = scope.managers.find((manager) => manager.hrId === filters.managerHrId) ?? null;
    const chosenManager = chosenManagerEntry ? `${chosenManagerEntry.name} · ${chosenManagerEntry.title}` : null;

    const buffer = await buildPhoenixCrmReportsWorkbook({
      adoption,
      bricks,
      calendar,
      capacity,
      coverage,
      dailyPlan,
      exceptions,
      frequency,
      generatedAtIso: new Date().toISOString(),
      heard,
      includeTest,
      locations,
      managers: scope.hasManagers ? managers : null,
      objections,
      periodText:
        `${visits.period.from} to ${visits.period.to} · coverage${samples ? " and samples" : ""} for ${coverage.month.month}`
        + (capacity ? ` · grade against capacity for ${capacity.month.month}` : "")
        + (dailyPlan ? ` · daily plan ${dailyPlan.period.from} to ${dailyPlan.period.to}` : ""),
      plan,
      samples,
      stock,
      tracking,
      scopeText: [chosenTerritory, chosenManager, chosenLine, `${scope.territories.length} territories in scope`]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
      viewerName: nameOf(names, viewer.hrId),
      visits,
    });

    // A workbook naming individual employees and their work leaves the building, so the fact that it
    // was taken is recorded — including WHICH sheets it held, since that is what it discloses. The row
    // is written once the file has gone: `writeAuditLog` already swallows its own failure, so the
    // download never depended on it, and the person no longer waits for the insert.
    await afterResponse("phoenix_crm_reports_export_audit", () =>
      writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: null,
        entityType: "phoenix_crm_reports_export",
        summary:
          `Exported the Phoenix CRM reports pack (${visits.period.from} to ${visits.period.to}, `
          + `${scope.territories.length} territories, manager sections ${managerSections ? "included" : "withheld"}, `
          + `daily plan ${dailyPlan ? `of ${dailyPlan.territory?.name} ${dailyPlan.period.from} to ${dailyPlan.period.to}` : "not included"})`,
      }),
    );

    return xlsxResponse(buffer, `phoenix-crm-reports-${visits.period.from}-to-${visits.period.to}.xlsx`);
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
