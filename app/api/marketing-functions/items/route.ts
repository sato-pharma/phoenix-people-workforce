import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { todayInCairo } from "@/lib/date-only";
import { marketingFunctionsErrorResponse, readJsonBody } from "@/lib/marketing-functions/http";
import { resolveMonthKey } from "@/lib/marketing-functions/months";
import { loadMonthSheet, saveMonthItems } from "@/lib/marketing-functions/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// He saves his whole month as it stands on his screen. Only the Product Manager himself, and only
// while the month is a draft: the service refuses a submitted or reviewed one.
export async function PUT(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "marketing_functions", "update");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 60,
      scope: "marketing-functions:items",
      windowMs: 60_000,
    });

    const body = await readJsonBody(request);
    const monthKey = resolveMonthKey(body.month, todayInCairo());
    await saveMonthItems(access, { items: body.items, monthKey });
    const sheet = await loadMonthSheet(access, { monthKey });
    return NextResponse.json({ ok: true, sheet });
  } catch (error) {
    return marketingFunctionsErrorResponse(error, "Failed to save the month.");
  }
}
