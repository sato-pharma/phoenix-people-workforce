import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { logError } from "@/lib/observability/log";
import { loadSuperAdminCrmQueueBadges, type SuperAdminCrmQueueBadges } from "@/lib/phoenix-crm/server/needs-you";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge counts for the Super Admin's own Phoenix CRM rows — Place Checks, SFE Recommendations, Camera
// Reviews, Late Visits and Visit Recording (owner, 27 Nov 2026). The sidebar reads these through the
// batched pulse (BATCH_KEY_BY_SRC in src/lib/nav-badge-store.ts); this route answers one queue at a time
// for any non-batched consumer, in the same {count} shape as its siblings.
//
// No permission gate of its own beyond the registry's: `loadSuperAdminCrmQueueBadges` returns zeros to
// anyone who is not the Super Admin, and asks each count under the deciding page's own gate.
const QUEUE_SLOT: Record<string, keyof SuperAdminCrmQueueBadges> = {
  "place-checks": "placeChecks",
  "sfe-recommended-checks": "sfeRecommendedChecks",
  "camera-reviews": "cameraReviews",
  "late-visits": "lateVisits",
  "recorded-visits": "recordedVisits",
};

export async function GET(request: Request) {
  const slot = QUEUE_SLOT[new URL(request.url).searchParams.get("queue") ?? ""];
  if (!slot) return NextResponse.json({ count: 0 }, { headers: { "Cache-Control": "no-store" } });
  try {
    const access = await resolveAccessContext(request);
    const badges = await loadSuperAdminCrmQueueBadges(access);
    return NextResponse.json(badges[slot], { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logError("Phoenix CRM queue badge count failed", {
      labels: { event: "phoenix_crm_queue_badge_count_failed" },
      error,
    });
    return NextResponse.json({ count: 0, unavailable: true }, { headers: { "Cache-Control": "no-store" } });
  }
}
