import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { afterResponse } from "@/lib/http/after-response";
import { marketingFunctionsErrorResponse, readJsonBody, uuidOrNull } from "@/lib/marketing-functions/http";
import { notifyMonthReviewed } from "@/lib/marketing-functions/notify";
import { reviewMonth } from "@/lib/marketing-functions/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The reviewer's two moves on a Product Manager's month: stamp it Reviewed (it locks as the record),
// or reopen it so he can change it. The Group Product Manager, the Marketing Manager, the Super Admin.
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "marketing_functions", "approve");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 30,
      scope: "marketing-functions:review",
      windowMs: 60_000,
    });

    const body = await readJsonBody(request);
    const monthId = uuidOrNull(body.monthId);
    if (!monthId) return NextResponse.json({ message: "That month does not exist." }, { status: 404 });
    const decision = body.decision === "reopen" ? "reopen" : "review";
    const note = typeof body.note === "string" ? body.note : null;
    const month = await reviewMonth(access, { decision, monthId, note });
    const reviewerName = (await namesByHrId([access.hrId])).get(access.hrId) ?? "Your reviewer";
    await afterResponse("marketing-functions:notify-reviewed", () => notifyMonthReviewed(month, decision, reviewerName));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return marketingFunctionsErrorResponse(error, "Failed to save the review.");
  }
}
