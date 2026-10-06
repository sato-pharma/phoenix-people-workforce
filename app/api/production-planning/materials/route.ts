import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { productionPlanningErrorResponse } from "@/lib/production-planning/http";
import { saveMaterialAndComposition } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A material's own fields, and its line in the formula.
 *
 * The formula is VERSIONED, never edited in place: a change closes the row in force on the day it
 * changes and opens a new one. So a plan committed last month still reproduces under the formula it
 * was committed with, and the history says when the composition moved and who moved it.
 */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const saved = await saveMaterialAndComposition(access, body);
    return NextResponse.json(saved);
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not save the material.");
  }
}
