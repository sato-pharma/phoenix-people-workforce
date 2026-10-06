import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  PRODUCTION_PLANNING_CACHE_HEADERS,
  productionPlanningErrorResponse,
} from "@/lib/production-planning/http";
import { listRuns, recordRun } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const runs = await listRuns(access);
    return NextResponse.json({ runs }, { headers: PRODUCTION_PLANNING_CACHE_HEADERS });
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not load the recorded runs.");
  }
}

/**
 * Record a finished run.
 *
 * This is the call that turns the model from a guess into a measurement: the per-material opening,
 * delivered and closing figures give the database its own generated consumed quantity, and the
 * theory the run was compared against is stored beside it. From two runs onward the planner stops
 * using the 3% the owner guessed and starts using what EGPI actually consumed.
 *
 * A mistyped run is EXCLUDED with a written reason rather than deleted, so the record of what was
 * reported survives its own correction.
 */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const saved = await recordRun(access, body);
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not record the run.");
  }
}
