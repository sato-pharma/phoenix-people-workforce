import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { countDirectOrderAwaitingFast, getDirectOrderUnbookedBadge } from "@/lib/direct-orders/service";
import { countDirectOrderPendingValidations } from "@/lib/direct-orders/pharmacy-validation";
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
// SUMMING IS CORRECT, NOT A FUDGE. The three sets are provably disjoint: an order is either still
// in the chain (awaiting) or through it and waiting on Finance (unbooked), and the third counts
// PHARMACIES awaiting confirmation, not orders at all. Nothing can be counted twice.
//
// THE THIRD TERM IS NOT OPTIONAL. Without it the badge read 9 while the workspace it opens read 12
// (measured 2026-08-11), because the Needs Action inbox counts all three queues. A badge that
// disagrees with the screen behind it teaches people to distrust both. Each half is also already gated to people who can clear it —
// `getDirectOrderUnbookedBadge` returns 0 to anyone who cannot set a sales month, and
// `countDirectOrderAwaiting` only counts rungs the viewer can act on — so the total stays a number
// the reader can actually do something about, which is the whole point of a badge.
//
// COST. Uses `countDirectOrderAwaitingFast`, which reads two tables and only the six columns the
// eligibility decision needs. The obvious call, `countDirectOrderAwaiting`, delegates to
// `getDirectOrderWorkspaceData` and would additionally load held/expired rows, decision history,
// pharmacies, caps, employee names and the live seat model to produce the same integer — on a 30s
// poll, for every user with a sidebar open. The eligibility RULE is shared either way
// (resolveActiveStep + viewerCanActOnStep), so the badge cannot drift from the screen.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const [awaiting, unbooked, validations] = await Promise.all([
      countDirectOrderAwaitingFast(access),
      getDirectOrderUnbookedBadge(access),
      countDirectOrderPendingValidations(access),
    ]);
    return NextResponse.json(
      { count: awaiting + unbooked.count + validations, overdue: unbooked.overdue },
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
