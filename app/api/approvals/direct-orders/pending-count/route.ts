import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { countDirectOrderAwaitingFast } from "@/lib/direct-orders/service";
import { logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Direct Orders Approvals" sidebar link.
//
// That link was retired on 2026-08-10 when the module collapsed into one workspace row, so nothing
// in the product points here any more — but the endpoint is still reachable directly and still
// registered, so it stays correct rather than being left to rot.
//
// Counts ONLY requests waiting on this caller's own rung: countDirectOrderAwaitingFast filters
// every pending request through resolveActiveStep + viewerCanActOnStep, so an approver never sees a
// count for a rung that isn't theirs.
//
// No `overdue` field: unlike vacation/excuse/plan, the direct-order module has no per-request SLA
// threshold defined, so there is nothing to graduate the badge's urgency on. Kept to the {count}
// shape the Approvals-Hub badge uses. Callers normally reach this through the batched
// /api/approvals/badge-counts response (see BATCH_KEY_BY_SRC in src/lib/nav-badge-store.ts); this
// dedicated endpoint remains for any non-batched consumer and mirrors its siblings.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "direct_orders", "read");
    return NextResponse.json({ count: await countDirectOrderAwaitingFast(access) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // This used to `catch {}` and return a bare `count: 0`. A DB outage, a statement timeout and a
    // genuinely empty queue then produced the identical answer, and the failure was never recorded
    // anywhere — so an approver with money waiting on their rung saw no badge and no reason to look.
    // `count` stays 0 so every existing badge consumer keeps working unchanged; `unavailable` lets a
    // caller tell "nothing is waiting" from "we could not find out", and the log makes it visible.
    logError("Direct order pending-count failed", {
      labels: { event: "direct_order_pending_count_failed" },
      error,
    });
    return NextResponse.json({ count: 0, unavailable: true }, { headers: { "Cache-Control": "no-store" } });
  }
}
