import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  PRODUCTION_PLANNING_CACHE_HEADERS,
  productionPlanningErrorResponse,
} from "@/lib/production-planning/http";
import { listAccessGrants, saveAccessGrant } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who else can reach the planner. FULL CONTROL ONLY, both ways: this names people and says what each
 * of them may see, and the screen carries every raw-material price and order cost.
 *
 * It exists so the owner's promise about Reham, read-only now and more later, is a row somebody
 * types rather than a release somebody has to ship. The named lists in access.ts are checked FIRST,
 * so a row here can admit a sixth person and can never demote one of the five he named.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const grants = await listAccessGrants(access);
    return NextResponse.json({ grants }, { headers: PRODUCTION_PLANNING_CACHE_HEADERS });
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not load the access list.");
  }
}

export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const saved = await saveAccessGrant(access, body);
    return NextResponse.json(saved);
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not save the access change.");
  }
}
