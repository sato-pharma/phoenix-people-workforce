import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getMarketingApproverBadge } from "@/lib/marketing-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Marketing Approval Inbox" sidebar tab (admin shell) and "Marketing Requests
// Inbox" (employee portal). Marketing is deliberately excluded from the consolidated approvals hub,
// so "approvals-hub-pending" can never cover it — this is its own count source.
//
// No assertPermission call, unlike the vacation/excuse/plan/direct-order siblings: marketing has no
// permission resource of its own, and getMarketingApproverBadge is scoped entirely by the caller's
// linked HR identity (`assigned_hr_id`), exactly like /api/marketing-requests/inbox. An actor with
// no Phoenix HR identity is rejected inside the service and falls through to {count: 0}.
//
// Callers normally reach this through the batched /api/approvals/badge-counts response (see
// BATCH_KEY_BY_SRC in src/lib/nav-badge-store.ts); this dedicated endpoint mirrors its siblings and
// remains for any non-batched consumer.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getMarketingApproverBadge(access), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ count: 0, overdue: false });
  }
}
