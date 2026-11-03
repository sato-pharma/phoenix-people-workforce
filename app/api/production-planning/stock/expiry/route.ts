import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { productionPlanningErrorResponse } from "@/lib/production-planning/http";
import { changeStockLotExpiry } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Move a lot to another expiry date. Append-only, like every stock report. */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const saved = await changeStockLotExpiry(access, body);
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not change the expiry date.");
  }
}
