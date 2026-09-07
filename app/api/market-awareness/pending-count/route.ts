import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getMarketAwarenessDecisionBadge } from "@/lib/market-awareness/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Awareness Approvals" nav item. Market Awareness keeps its own inbox rather
// than folding into the consolidated approvals hub (the owner asked for a separate queue), so
// "approvals-hub-pending" can never cover it — this is its own count source, exactly like marketing.
//
// The service asserts market_awareness:read and then narrows to the decisions that are actually the
// caller's, so a role that holds the resource but no decision gets 0 rather than a refusal, and a
// role without the resource falls through the catch to the same {count: 0} every sibling returns —
// one unhappy domain never blanks the other badges.
//
// Callers normally reach this through the batched /api/approvals/badge-counts response (see
// BATCH_KEY_BY_SRC in src/lib/nav-badge-store.ts); this dedicated endpoint mirrors its siblings and
// remains for any non-batched consumer.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getMarketAwarenessDecisionBadge(access), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ count: 0, overdue: false });
  }
}
