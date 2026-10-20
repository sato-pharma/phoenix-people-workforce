import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { hrOpsErrorResponse, reportIdOrNull } from "@/lib/hr-ops-reports/http";
import { submitReport } from "@/lib/hr-ops-reports/review";
import { viewReport } from "@/lib/hr-ops-reports/serialize";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// She hands the report to the HR Manager. Every flagged row must carry her answer first; once sent
// the report is frozen — the cron no longer rebuilds it and she can no longer change a row.
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_ops_reports", "update");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 30,
      scope: "hr-ops-reports:submit",
      windowMs: 60_000,
    });

    const id = reportIdOrNull((await context.params).id);
    if (!id) return NextResponse.json({ message: "That report does not exist." }, { status: 404 });
    const { report } = await submitReport(access, id);
    return NextResponse.json({ ok: true, report: viewReport(report) });
  } catch (error) {
    return hrOpsErrorResponse(error, "Failed to submit the report.");
  }
}
