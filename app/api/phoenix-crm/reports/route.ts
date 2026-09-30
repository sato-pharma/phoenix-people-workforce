import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { validationError } from "@/lib/http/api-errors";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadDailyPlanReport } from "@/lib/phoenix-crm/server/daily-plan-report";
import { loadBrickCoverageReport } from "@/lib/phoenix-crm/server/brick-report";
import { loadAdoptionReport } from "@/lib/phoenix-crm/server/adoption";
import { loadExceptionsBoard } from "@/lib/phoenix-crm/server/exceptions";
import {
  loadCoverageReport,
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
//   coverage  coverage and frequency for a month
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
//   adoption  how far the ROLLOUT has got — who has never opened the module at all (F3). Same gate,
//             and it reads the viewer's WAITING territories too, since a territory whose line has
//             not opened is the other half of the same question. Nothing on it acts.
// Filters: seatId, lineCode, from, to, month, includeTest (the Super Admin's only). Scope runs
// downward only and is applied in the service.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const filters: ReportFilterInput = {
      seatId: search.get("seatId"),
      lineCode: search.get("lineCode"),
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
    else if (section === "managers") report = await loadManagerReport(viewer, filters);
    else if (section === "locations") report = await loadVisitLocationReport(viewer, filters);
    else if (section === "exceptions") report = await loadExceptionsBoard(viewer, { test: filters.includeTest });
    else if (section === "bricks") report = await loadBrickCoverageReport(viewer, filters);
    else if (section === "adoption") report = await loadAdoptionReport(viewer, { test: filters.includeTest });
    else throw validationError("Choose a report.");
    return NextResponse.json({ report, section, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the report.");
  }
}
