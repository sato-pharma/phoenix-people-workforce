import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { hrOpsErrorResponse, reportIdOrNull } from "@/lib/hr-ops-reports/http";
import { reviewLines } from "@/lib/hr-ops-reports/review";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Her answer to one or more rows: confirm, reject or recommend an edit (days only), with a reason.
// Only while the report is still with her; the service refuses a submitted or decided one.
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_ops_reports", "update");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 240,
      scope: "hr-ops-reports:review",
      windowMs: 60_000,
    });

    const id = reportIdOrNull((await context.params).id);
    if (!id) return NextResponse.json({ message: "That report does not exist." }, { status: 404 });
    const body = await request.json().catch(() => null);
    return NextResponse.json({ ok: true, ...(await reviewLines(access, id, body)) });
  } catch (error) {
    return hrOpsErrorResponse(error, "Failed to save your review.");
  }
}
