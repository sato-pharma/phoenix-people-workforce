import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { countDirectOrderAwaiting } from "@/lib/direct-orders/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Direct Orders Approvals" sidebar link — the only Approvals Hub tab that had
// no badge, even though countDirectOrderAwaiting was already written (with zero consumers).
//
// Counts ONLY requests waiting on this caller's own rung: countDirectOrderAwaiting delegates to
// getDirectOrderWorkspaceData, which filters every pending request through viewerCanActOnStep, so an
// approver never sees a count for a rung that isn't theirs.
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
    return NextResponse.json({ count: await countDirectOrderAwaiting(access) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
