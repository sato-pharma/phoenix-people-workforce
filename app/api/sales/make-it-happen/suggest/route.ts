import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { makeItHappenErrorResponse } from "@/lib/sales/make-it-happen/api-response";
import { suggestRealisticPlan } from "@/lib/sales/make-it-happen/plans";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// "Press here and Phoenix will Make It Happen": the realistic unit mix for the caller's scope and
// period, plus the one sentence that explains it. Writes nothing.
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    const suggestion = await suggestRealisticPlan(access, await request.json().catch(() => null));
    return NextResponse.json({ suggestion, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return makeItHappenErrorResponse(error, "Phoenix could not build a plan right now.");
  }
}
