import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { productionPlanningErrorResponse } from "@/lib/production-planning/http";
import { updateSettings } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The settings singleton: the default overage, the reorder threshold, and the four arming flags.
 *
 * An arming flag moves only on an explicit boolean, so a typo in a payload cannot switch the email
 * on. Switching the reorder email on or off writes a REQUIRED audit row, because it is the moment
 * this module starts speaking to people outside it. Every other field here is a reversible
 * threshold and takes the ordinary trail.
 */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const saved = await updateSettings(access, body);
    return NextResponse.json(saved);
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not save the settings.");
  }
}
