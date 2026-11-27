import { NextResponse } from "next/server";

import { loadOwnerQueueBadges, OWNER_QUEUE_SLOT_BY_NAME } from "@/lib/approvals-hub/owner-queue-badges";
import { resolveAccessContext } from "@/lib/auth/server";
import { logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge counts for the owner's seven queue shortcuts (27 Nov 2026). The sidebar reads them through the batched
// pulse (BATCH_KEY_BY_SRC in src/lib/nav-badge-store.ts); this route answers one queue at a time for any
// non-batched consumer, in the same {count} shape as its siblings, plus `unavailable: true` when the count
// could not be read — never a bare 0 for a failed read.
//
// No gate of its own beyond the registry's: `loadOwnerQueueBadges` returns empty slots to anyone who is not
// the Super Admin, and asks each count under the gate of the page its row opens.
export async function GET(request: Request) {
  const slot = OWNER_QUEUE_SLOT_BY_NAME[new URL(request.url).searchParams.get("queue") ?? ""];
  if (!slot) return NextResponse.json({ count: 0 }, { headers: { "Cache-Control": "no-store" } });
  try {
    const access = await resolveAccessContext(request);
    const badges = await loadOwnerQueueBadges(access);
    return NextResponse.json(badges[slot], { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logError("Owner queue badge count failed", { labels: { event: "owner_queue_badge_route_failed" }, error });
    return NextResponse.json({ count: 0, unavailable: true }, { headers: { "Cache-Control": "no-store" } });
  }
}
