import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  PRODUCTION_PLANNING_CACHE_HEADERS,
  productionPlanningErrorResponse,
} from "@/lib/production-planning/http";
import { getProductionPlanningWorkspace } from "@/lib/production-planning/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The whole Production Planner workspace in one read: products, materials, the formula, stock in
 * both locations, prices, the exchange rate, the settings, the recorded runs, the saved plans, and
 * the plan for whatever is in the query string.
 *
 * One request rather than five, because the five tabs all divide by the same figures: a stock tab
 * that fetched its own copy would sooner or later show a cover the planner tab disagreed with.
 *
 * The gate is resolveProductionPlanningLevel inside the service, not assertPermission. Two of the
 * five people the owner named hold app roles the matrix grants nothing, and granting those roles
 * would open the module to the whole company: src/lib/production-planning/access.ts says why.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const workspace = await getProductionPlanningWorkspace(access, {
      productId: url.searchParams.get("productId"),
      mode: url.searchParams.get("mode") ?? undefined,
      requestedQty: url.searchParams.get("requestedQty") ?? undefined,
      sampleUnits: url.searchParams.get("sampleUnits") ?? undefined,
    });
    return NextResponse.json(workspace, { headers: PRODUCTION_PLANNING_CACHE_HEADERS });
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not load the production planner.");
  }
}
