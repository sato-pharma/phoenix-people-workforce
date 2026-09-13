import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { makeItHappenErrorResponse } from "@/lib/sales/make-it-happen/api-response";
import { saveForecastPlan } from "@/lib/sales/make-it-happen/plans";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Save (or update) one of the caller's own Make It Happen plans. The role gate and the scope are
// re-decided inside saveForecastPlan, which rebuilds the caller's workspace before writing.
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    const plan = await saveForecastPlan(access, await request.json().catch(() => null));
    return NextResponse.json({ plan, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return makeItHappenErrorResponse(error, "Could not save the plan.");
  }
}
