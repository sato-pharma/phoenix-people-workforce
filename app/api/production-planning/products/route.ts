import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { productionPlanningErrorResponse } from "@/lib/production-planning/http";
import { updateProductPackaging } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many units and strips one box of a product holds — the figures a per-box line divides by. */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const saved = await updateProductPackaging(access, body);
    return NextResponse.json(saved, { status: 200 });
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not save the packaging.");
  }
}
