import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { validationError } from "@/lib/http/api-errors";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import {
  loadCoverageReport,
  loadManagerReport,
  loadPlanReport,
  loadReportScope,
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
    };
    const section = search.get("section") ?? "scope";
    let report: unknown;
    if (section === "scope") report = await loadReportScope(viewer);
    else if (section === "visits") report = await loadVisitsReport(viewer, filters);
    else if (section === "plan") report = await loadPlanReport(viewer, filters);
    else if (section === "coverage") report = await loadCoverageReport(viewer, filters);
    else if (section === "managers") report = await loadManagerReport(viewer, filters);
    else throw validationError("Choose a report.");
    return NextResponse.json({ report, section, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the report.");
  }
}
