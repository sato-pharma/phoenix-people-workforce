import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { todayInCairo } from "@/lib/date-only";
import { afterResponse } from "@/lib/http/after-response";
import { marketingFunctionsErrorResponse, readJsonBody } from "@/lib/marketing-functions/http";
import { resolveMonthKey } from "@/lib/marketing-functions/months";
import { notifyMonthSubmitted } from "@/lib/marketing-functions/notify";
import { submitMonth } from "@/lib/marketing-functions/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "At the end of each month, please complete the sheet": he submits it, and his manager is told it
// waits for her review. Once submitted he can no longer change it unless it is reopened.
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "marketing_functions", "update");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 20,
      scope: "marketing-functions:submit",
      windowMs: 60_000,
    });

    const body = await readJsonBody(request);
    const month = await submitMonth(access, resolveMonthKey(body.month, todayInCairo()));
    await afterResponse("marketing-functions:notify-submitted", () => notifyMonthSubmitted(month));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return marketingFunctionsErrorResponse(error, "Failed to submit the month.");
  }
}
