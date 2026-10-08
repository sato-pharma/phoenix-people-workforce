import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { productionPlanningErrorResponse } from "@/lib/production-planning/http";
import { saveMaterialAndComposition, setMaterialActive } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A material's own fields, its line in the formula, and whether it is retired.
 *
 * The formula is VERSIONED, never edited in place: a change closes the row in force on the day it
 * changes and opens a new one. So a plan committed last month still reproduces under the formula it
 * was committed with, and the history says when the composition moved and who moved it.
 *
 * 🔴 A body carrying `active` is a RETIRE or a RESTORE and goes nowhere near the field save. The
 * two are split on the PRESENCE of the key, never on its value: `body.active === false` and a body
 * with no `active` at all are different requests, and a truthiness test would read the first as the
 * second and silently save fields instead of retiring. The service refuses a non-boolean rather
 * than defaulting, because either default does the opposite of one of the two intentions.
 */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if ("active" in body) {
      return NextResponse.json(await setMaterialActive(access, body));
    }
    const saved = await saveMaterialAndComposition(access, body);
    return NextResponse.json(saved);
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not save the material.");
  }
}
