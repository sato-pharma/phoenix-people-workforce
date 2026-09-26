import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { validationError } from "@/lib/http/api-errors";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadBrickCoverageReport } from "@/lib/phoenix-crm/server/brick-report";
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
    else if (section === "visits") report = await loadVisitsReport(viewer, filters);
    else if (section === "plan") report = await loadPlanReport(viewer, filters);
    else if (section === "coverage") report = await loadCoverageReport(viewer, filters);
    else if (section === "managers") report = await loadManagerReport(viewer, filters);
    else if (section === "locations") report = await loadVisitLocationReport(viewer, filters);
    else if (section === "exceptions") report = await loadExceptionsBoard(viewer, { test: filters.includeTest });
    else if (section === "bricks") report = await loadBrickCoverageReport(viewer, filters);
    else throw validationError("Choose a report.");
    return NextResponse.json({ report, section, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the report.");
  }
}
