import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { productionPlanningErrorResponse } from "@/lib/production-planning/http";
import { addMaterialPrice } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A price, in ONE currency, exactly as typed. The other currency is derived at read time from the
 * day's exchange rate and is never stored: two stored currencies for one number are two truths, and
 * the day the rate moves they disagree with each other.
 *
 * The audit row is written with writeRequiredAuditLog. A price change that is not recorded is a
 * failed price change, because the order cost moves and nobody can say afterwards who moved it.
 */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const saved = await addMaterialPrice(access, body);
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not record the price.");
  }
}
