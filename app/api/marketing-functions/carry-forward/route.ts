import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { todayInCairo } from "@/lib/date-only";
import { marketingFunctionsErrorResponse, readJsonBody } from "@/lib/marketing-functions/http";
import { resolveMonthKey } from "@/lib/marketing-functions/months";
import { carryForwardMonth } from "@/lib/marketing-functions/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Copies every item of his month that is neither done nor cancelled into next month's plan.
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "marketing_functions", "update");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 20,
      scope: "marketing-functions:carry-forward",
      windowMs: 60_000,
    });

    const body = await readJsonBody(request);
    const result = await carryForwardMonth(access, resolveMonthKey(body.month, todayInCairo()));
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return marketingFunctionsErrorResponse(error, "Failed to carry the items forward.");
  }
}
