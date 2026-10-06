import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  PRODUCTION_PLANNING_CACHE_HEADERS,
  productionPlanningErrorResponse,
} from "@/lib/production-planning/http";
import { listPlans, savePlan } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const plans = await listPlans(access);
    return NextResponse.json({ plans }, { headers: PRODUCTION_PLANNING_CACHE_HEADERS });
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not load the saved plans.");
  }
}

/**
 * Save a draft, or commit one.
 *
 * `commit: true` is the only call in this module that freezes anything: it writes the geometry, the
 * overage and the exchange rate in force beside the plan, so a cost agreed in January still
 * reproduces in June. A draft stores no lines at all and recomputes live, which is why a draft can
 * never end up disagreeing with the current formula or the current stock.
 */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const saved = await savePlan(access, body);
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not save the plan.");
  }
}
