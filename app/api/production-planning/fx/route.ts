import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { productionPlanningErrorResponse } from "@/lib/production-planning/http";
import { setManualFxRate } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A USD to EGP rate typed by a person, for one date.
 *
 * It beats whatever the daily fetch found, and a failed fetch never overwrites it: the fetched
 * figure, the manual figure and whether the fetch succeeded are three separate columns precisely so
 * that a bad fetch cannot quietly replace a rate somebody chose.
 */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const saved = await setManualFxRate(access, body);
    return NextResponse.json(saved);
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not save the exchange rate.");
  }
}
