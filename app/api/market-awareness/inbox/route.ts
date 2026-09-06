import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { marketAwarenessErrorResponse } from "@/lib/market-awareness/api-response";
import { listDecisionInbox } from "@/lib/market-awareness/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything waiting for the caller to decide. Scoped inside the service by the same predicate the
 * decision route enforces, so this can never offer a row the server would refuse.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const activities = await listDecisionInbox(access);
    return NextResponse.json(
      { activities, success: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not load the approvals inbox.");
  }
}
