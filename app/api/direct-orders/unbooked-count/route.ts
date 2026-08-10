import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getDirectOrderUnbookedBadge } from "@/lib/direct-orders/service";
import { logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Direct Orders" sidebar row: approved orders that still carry no sales month.
//
// Distinct from /api/approvals/direct-orders/pending-count, which counts orders awaiting the
// caller's own APPROVAL rung. These two never overlap: an order is either still in the chain
// (pending-count) or through it and waiting on Finance (this one). The Finance Manager holds no
// approval rung at all, so the other badge is permanently 0 for him and its nav row is hidden from
// him anyway — without this endpoint he has no badge on any queue he actually owns.
//
// getDirectOrderUnbookedBadge asserts direct_orders:read itself and then returns {count: 0} for
// anyone who cannot set a sales month, so the shared sidebar row stays unbadged for the sales
// roles that also reach it. See the function's own note for why that gate is not optional.
//
// Callers normally arrive through the batched /api/approvals/badge-counts response (see
// BATCH_KEY_BY_SRC in src/lib/nav-badge-store.ts); this dedicated endpoint mirrors its siblings for
// any non-batched consumer.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getDirectOrderUnbookedBadge(access), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    // Same shape and same reasoning as the pending-count sibling: `count` stays 0 so every badge
    // consumer keeps working, `unavailable` lets a caller tell "nothing waiting" from "we could not
    // find out", and the log makes the difference visible instead of silently reading as an empty
    // queue on the one surface that exists to stop money going uncounted.
    logError("Direct order unbooked-count failed", {
      labels: { event: "direct_order_unbooked_count_failed" },
      error,
    });
    return NextResponse.json(
      { count: 0, overdue: false, unavailable: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
