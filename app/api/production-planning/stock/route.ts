import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { productionPlanningErrorResponse } from "@/lib/production-planning/http";
import { addStockEntry, reverseStockEntry } from "@/lib/production-planning/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record what the factory reported.
 *
 * Append-only: the newest report for a material in a location IS the current figure, and nothing is
 * ever overwritten. A correction is a newer report, so the trail of what was believed on each date
 * survives, which is the only way to read back afterwards why an order was the size it was.
 */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // `action: "reverse"` puts one wrong entry right (owner, 2026-11-24). Both writers assert write
    // access before they read anything else from the body, so an anonymous call is still a 401/403.
    const saved = body.action === "reverse" ? await reverseStockEntry(access, body) : await addStockEntry(access, body);
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not record the stock report.");
  }
}
