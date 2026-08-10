import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { countDirectOrderAwaiting, getDirectOrderUnbookedBadge } from "@/lib/direct-orders/service";
import { logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the ONE Direct Orders sidebar row.
//
// WHY THIS EXISTS. Collapsing the module's five sidebar entries to one left two badges competing
// for a single row: `direct-orders-approvals-pending` (orders awaiting the caller's own approval
// rung) and `direct-orders-unbooked` (approved orders with no sales month — Finance's queue). A nav
// item carries one badge, so keeping either alone would have silently dropped the other, and the
// audiences barely overlap: the Finance Manager holds no approval rung, and no approver can book a
// month. Whichever we picked, one group would have lost the only ambient chaser they have.
//
// SUMMING IS CORRECT, NOT A FUDGE. The two sets are provably disjoint: an order is either still in
// the chain (awaiting) or through it and waiting on Finance (unbooked). Nothing can be counted
// twice. Each half is also already gated to people who can clear it —
// `getDirectOrderUnbookedBadge` returns 0 to anyone who cannot set a sales month, and
// `countDirectOrderAwaiting` only counts rungs the viewer can act on — so the total stays a number
// the reader can actually do something about, which is the whole point of a badge.
//
// COST. `countDirectOrderAwaiting` delegates to `getDirectOrderWorkspaceData`, which loads every
// pending row company-wide. That is not new cost: it is exactly what
// /api/approvals/direct-orders/pending-count already did on the same 30s poll, and this endpoint
// replaces that call rather than adding to it. Making it cheap is tracked in
// docs/specs/direct-orders-workspace.md.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const [awaiting, unbooked] = await Promise.all([
      countDirectOrderAwaiting(access),
      getDirectOrderUnbookedBadge(access),
    ]);
    return NextResponse.json(
      { count: awaiting + unbooked.count, overdue: unbooked.overdue },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Same shape and reasoning as both siblings: `count` stays 0 so every badge consumer keeps
    // working, `unavailable` lets a caller tell "nothing waiting" from "we could not find out".
    logError("Direct order needs-action count failed", {
      labels: { event: "direct_order_needs_action_count_failed" },
      error,
    });
    return NextResponse.json(
      { count: 0, overdue: false, unavailable: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
