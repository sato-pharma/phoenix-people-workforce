import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { validationError } from "@/lib/http/api-errors";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadDailyPlanReport } from "@/lib/phoenix-crm/server/daily-plan-report";
import { loadBrickCoverageReport } from "@/lib/phoenix-crm/server/brick-report";
import { loadAdoptionReport } from "@/lib/phoenix-crm/server/adoption";
import { loadTeamCalendar } from "@/lib/phoenix-crm/server/team-calendar";
import { loadExceptionsBoard } from "@/lib/phoenix-crm/server/exceptions";
import { loadCapacityBoard, loadFieldHeardReport, loadMissingStockReport, loadObjectionsByCustomerReport, loadSamplesReport } from "@/lib/phoenix-crm/server/insight-reports";
import {
  loadCoverageReport,
  loadCustomerFrequencyReport,
  loadTrackingSheetReport,
  loadManagerReport,
  loadPlanReport,
  loadReportScope,
  loadVisitLocationReport,
  loadVisitsReport,
  type ReportFilterInput,
} from "@/lib/phoenix-crm/server/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = one section of the module's own report, so a phone reads only the section on screen:
//   scope     what the filters can offer (the viewer's lines and territories)
//   daily     ONE territory's plan, day by day (owner, 2026-09-30): each day's start times and other
//             activities, then its AM and its PM customers — where each one is, and whether he was
//             seen. It reaches FORWARD to the last plannable day, and a rep reads his own plan here.
//   visits    visits per rep per day, AM and PM apart
//   plan      plan against actual, per day
//   coverage  coverage and frequency for a month, per TERRITORY
//   frequency how often each CUSTOMER was seen, against his grade's number and against how often
//             he was planned — the two apart (owner, 2026-09-30). One territory at a time: this
//             is per customer, and a national scope is thousands of rows
//   tracking  every customer down the side, every day across the top, a mark where a visit
//             landed. The spacing note beside it is a MANAGER's — a judgement about how a rep
//             worked his month never reaches the rep (Golden rule #1)
//   managers  double and chain visits per manager
//   locations where the rep stood against where the customer's place is saved — a manager's report,
//             refused to a medical rep inside the service (owner, 2026-09-26)
//   exceptions the few territories that need a manager today — a territory with nothing wrong is
//             ABSENT, so this is the one section whose usefulness is what it LEAVES OUT. Same gate as
//             locations (readsTeamReports) and nothing on it acts.
//   bricks    coverage against what the closing booked ON each brick (C2). The CRM half is computed
//             natively from the places captured in this module; the sales half comes through the
//             shared closing loader with the EL QEMA MASK applied in the service, never here. Same
//             gate again, and the view carries a fixed caveat: brick sales never sum to the area.
//   calendar  the month, one square per day, AM and PM apart and pharmacies in the day's detail —
//             its own TAB in the module, and a MANAGER's view (readsTeamReports), because a month
//             of a rep's team laid out for comparison is not his to read (Golden rule #1)
//   adoption  how far the ROLLOUT has got — who has never opened the module at all (F3). Same gate,
//             and it reads the viewer's WAITING territories too, since a territory whose line has
//             not opened is the other half of the same question. Nothing on it acts.
//   capacity  grade against capacity (owner, 2026-10-02): what each territory's LIST asks of a month,
//             by grade, against what the month's field days hold — list size, never coverage. A
//             manager's board (readsTeamReports), refused to a medical rep inside the service
//   heard     what the field heard: the products discussed and the customers' objections, by product,
//             speciality and area, AM and PM apart — counts only, never a "no objection" figure, never
//             per rep. The managers' board, and the product and marketing managers' one report: their
//             own products, company-wide, with no area (owner, 2026-10-02)
//   stock     the missing-stock board: which pharmacies last said they do not have which product, and
//             the visits that promised to chase it. No sales figure. Managers only
//   samples   samples and materials left, by month, by product and territory — a record, never a stock
//             balance. Managers only
//   objections objections by customer (owner, 2026-11-03): each rep's customers and what they objected to,
//             counts only. Managers only, and it never scores a rep
// Filters: seatId, lineCode, managerHrId (owner, 2026-10-20 — one of the viewer's managers), from, to, month,
// includeTest (the Super Admin's only). Scope runs downward only and is applied in the service.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const filters: ReportFilterInput = {
      seatId: search.get("seatId"),
      lineCode: search.get("lineCode"),
      // One of the viewer's managers (owner, 2026-10-20: "when filter by manager u find no manager"); refused in
      // the service when he is not the viewer's.
      managerHrId: search.get("managerHrId"),
      includeTest: search.get("includeTest"),
      from: search.get("from"),
      to: search.get("to"),
      month: search.get("month"),
      // C3: what the figures are read against. Refused to a rep inside the service, not here.
      compare: search.get("compare"),
    };
    const section = search.get("section") ?? "scope";
    let report: unknown;
    if (section === "scope") report = await loadReportScope(viewer);
    else if (section === "daily") report = await loadDailyPlanReport(viewer, filters);
    else if (section === "visits") report = await loadVisitsReport(viewer, filters);
    else if (section === "plan") report = await loadPlanReport(viewer, filters);
    else if (section === "coverage") report = await loadCoverageReport(viewer, filters);
    else if (section === "frequency") report = await loadCustomerFrequencyReport(viewer, filters);
    else if (section === "tracking") report = await loadTrackingSheetReport(viewer, filters);
    else if (section === "managers") report = await loadManagerReport(viewer, filters);
    else if (section === "locations") report = await loadVisitLocationReport(viewer, filters);
    else if (section === "exceptions") report = await loadExceptionsBoard(viewer, { test: filters.includeTest });
    else if (section === "bricks") report = await loadBrickCoverageReport(viewer, filters);
    else if (section === "adoption") report = await loadAdoptionReport(viewer, { test: filters.includeTest });
    // The four insight boards of 2026-10-02. Each one gates and scopes itself in the service.
    else if (section === "capacity") report = await loadCapacityBoard(viewer, filters);
    else if (section === "heard") report = await loadFieldHeardReport(viewer, filters);
    else if (section === "stock") report = await loadMissingStockReport(viewer, filters);
    else if (section === "samples") report = await loadSamplesReport(viewer, filters);
    else if (section === "objections") report = await loadObjectionsByCustomerReport(viewer, filters);
    // The team calendar. Its own TAB in the module (owner, 2026-09-30) but the module's own report
    // endpoint, so there is one place a Phoenix CRM report section is gated, scoped and audited.
    else if (section === "calendar") report = await loadTeamCalendar(viewer, { month: filters.month, test: filters.includeTest });
    else throw validationError("Choose a report.");
    return NextResponse.json({ report, section, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the report.");
  }
}
