import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { afterResponse } from "@/lib/http/after-response";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { loadVisitReport } from "@/lib/phoenix-crm/server/visit-report";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A quarter of one rep, or a month of a district, with several side tables read per chosen category.
export const maxDuration = 60;

/**
 * How many times a minute one person may press Apply. The workbook allows ten a minute for the same read;
 * the screen gets twice that, because pressing Apply again after changing one field is how it is used.
 */
const REPORTS_PER_MINUTE = 20;

// POST = the Visit report generator's answer for one rep or district, one period and the chosen fields
//        (owner, 2026-10-15): the visits, the dashboard figures and the map's points. A READ sent as a POST,
//        because the chosen fields do not belong in a URL, and audited as a read: it discloses where
//        named people's phones were.
//
// 🔴 The Super Admin and the SFE Manager (the company) and a district manager (his own team) — narrowed in the service (`canReadVisitReport`), which
// answers anybody else with a 404 so the report's existence is not confirmed. The SFE Manager's answer
// never holds the mock-location evidence: the loader does not read it for him.
//
// 🔴 THE RATE LIMIT RUNS BEFORE THE READ AND THE AUDIT ROW IS WRITTEN AFTER IT (2026-10-16). The access
// registry declared this read audited while nothing wrote a row — 0 on production against 6 for the
// workbook — so who looked up where a named person's phone was could not be answered. The row is written
// past the response, as the reports pack's is: a logging failure never refuses a reader the report he is
// allowed on, and only a report that was actually built is recorded.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: REPORTS_PER_MINUTE,
      scope: "phoenix_crm_visit_report",
      windowMs: 60_000,
    });
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as Record<string, unknown>;
    const view = await loadVisitReport(viewer, {
      fields: body.fields,
      from: body.from,
      id: body.id,
      kind: body.kind,
      to: body.to,
    });
    await afterResponse("phoenix_crm_visit_report_view_audit", () =>
      writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: null,
        entityType: "phoenix_crm_visit_report_view",
        summary:
          `Viewed the Visit report for ${view.target.name} (${view.period.from} to ${view.period.to}, `
          + `${view.total} visits, ${view.selected.length} fields)`,
      }),
    );
    return NextResponse.json({ success: true, view });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return phoenixCrmFailure(error, "Could not build the visit report.");
  }
}
