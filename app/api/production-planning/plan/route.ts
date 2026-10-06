import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  PRODUCTION_PLANNING_CACHE_HEADERS,
  productionPlanningErrorResponse,
} from "@/lib/production-planning/http";
import { computePlan, loadProductionPlanningData } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compute one plan and store nothing.
 *
 * A POST although it writes no row, for one reason: the planner carries a per-material "what I will
 * actually deliver" map, and fifteen decimal quantities do not belong in a query string, where they
 * would be logged, cached and eventually truncated. The CSRF check applies because it is a POST; the
 * access registry classifies it as access-read, which is what it is.
 */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // loadProductionPlanningData asserts read access before it reads anything.
    const data = await loadProductionPlanningData(access);
    const plan = computePlan(data, body);
    return NextResponse.json(plan, { headers: PRODUCTION_PLANNING_CACHE_HEADERS });
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not calculate the requirement.");
  }
}
