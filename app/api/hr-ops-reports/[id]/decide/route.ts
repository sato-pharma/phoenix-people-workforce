import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { decideLines } from "@/lib/hr-ops-reports/decide";
import { hrOpsErrorResponse, reportIdOrNull } from "@/lib/hr-ops-reports/http";
import { viewReport } from "@/lib/hr-ops-reports/serialize";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The HR Manager's decision on one or more rows: approve with the days that stand, or reject.
// `approve` is held by the Super Admin alone, so the reviewer can never decide her own row.
// Approved days are handed to the weekly attendance review (bridge.ts); a day whose week is not
// open yet waits there and the cron retries.
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_ops_reports", "approve");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 120,
      scope: "hr-ops-reports:decide",
      windowMs: 60_000,
    });

    const id = reportIdOrNull((await context.params).id);
    if (!id) return NextResponse.json({ message: "That report does not exist." }, { status: 404 });
    const body = await request.json().catch(() => null);
    const result = await decideLines(access, id, body);
    await writeAuditLog({
      actorLoginId: access.loginId ?? access.hrId ?? null,
      entityId: id,
      entityType: "hr_ops_report",
      newValues: { bridge: result.bridge, bridgeError: result.bridgeError, decided: result.decided, status: result.report.status },
      summary: `HR report decision: ${result.decided} ${result.decided === 1 ? "row" : "rows"} decided`,
    });
    return NextResponse.json({
      bridge: result.bridge,
      bridgeError: result.bridgeError,
      decided: result.decided,
      ok: true,
      report: viewReport(result.report),
    });
  } catch (error) {
    return hrOpsErrorResponse(error, "Failed to save the decision.");
  }
}
