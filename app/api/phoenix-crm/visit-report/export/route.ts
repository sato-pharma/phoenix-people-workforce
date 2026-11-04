import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { fieldsOfView, loadVisitReport } from "@/lib/phoenix-crm/server/visit-report";
import { buildVisitReportWorkbook } from "@/lib/phoenix-crm/server/visit-report-workbook";
import { describeVisitReportFilter, narrowVisitReportView, readVisitReportFilter } from "@/lib/phoenix-crm/visit-report-filters";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A file-name part: lower case, letters and digits, one dash between runs. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";
}

// GET = the Visit report as ONE workbook tab, in the house identity: exactly the chosen fields for exactly
//       the visits the same filter returns on the screen (owner, 2026-10-15). The fields travel as a
//       comma-separated `fields` parameter, because a download is a link. The result filters (who, day,
//       planned, position) travel the same way and narrow the visits through the SAME matcher as the screen
//       (`narrowVisitReportView`, 2026-10-16), so a narrowed page downloads as the same narrowed file.
//
// The rate limit runs BEFORE any load: a quarter of visits with every side table is a heavy read, and a
// limiter that fires afterwards has protected nothing. It is the same loader as the screen's, so the file
// can never hold a field, or a visit, the screen would refuse — the SFE Manager's file has no mock-location
// column because the loader never read it for him.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:phoenix-crm:visit-report" });

    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const loaded = await loadVisitReport(viewer, {
      customer: search.get("customer"),
      fields: (search.get("fields") ?? "").split(",").map((key) => key.trim()).filter(Boolean),
      from: search.get("from"),
      id: search.get("id"),
      kind: search.get("kind"),
      to: search.get("to"),
    });
    const filter = readVisitReportFilter((key) => search.get(key));
    const fields = fieldsOfView(loaded);
    const view = narrowVisitReportView(loaded, filter, fields);
    const narrowedTo = describeVisitReportFilter(filter);

    const names = await loadPeopleNames([viewer.hrId]);
    const buffer = await buildVisitReportWorkbook({
      fields,
      narrowedTo,
      view,
      viewerName: nameOf(names, viewer.hrId),
    });

    // A workbook naming individual employees and where their phones were leaves the building, so the fact
    // that it was taken is recorded — with what it covered and how many fields it disclosed.
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: null,
      entityType: "phoenix_crm_visit_report_export",
      summary:
        `Exported the Visit report for ${view.target.name} (${view.period.from} to ${view.period.to}, `
        + `${view.total} visits, ${view.selected.length} fields${narrowedTo ? `, only ${narrowedTo}` : ""})`,
    });

    return new NextResponse(buffer as unknown as ArrayBuffer, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="visit-report-${slug(view.target.name)}-${view.period.from}-to-${view.period.to}.xlsx"`,
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
    return phoenixCrmFailure(error, "Could not build the visit report workbook.");
  }
}
