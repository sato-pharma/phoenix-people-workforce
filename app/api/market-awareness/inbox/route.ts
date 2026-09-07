import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { marketAwarenessErrorResponse } from "@/lib/market-awareness/api-response";
import { listInbox } from "@/lib/market-awareness/service";
import type { MarketAwarenessInboxScope } from "@/lib/market-awareness/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The approvals inbox, in one of two scopes — the same two tabs the Marketing inbox has.
 *
 *   open     still moving through the chain
 *   history  answered: approved, rejected, withdrawn, executed or closed
 *
 * Rows are what the caller may SEE; `canDecide` on each says whether they may act. Both are decided
 * inside the service by the same predicates the decision route enforces, so this can never offer a
 * button the server would refuse.
 *
 * An unrecognised scope falls back to `open` rather than erroring: a stale bookmark should show the
 * live queue, not a failure.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const requested = new URL(request.url).searchParams.get("scope");
    const scope: MarketAwarenessInboxScope = requested === "history" ? "history" : "open";
    const rows = await listInbox(access, scope);
    return NextResponse.json(
      { rows, scope, success: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not load the approvals inbox.");
  }
}
