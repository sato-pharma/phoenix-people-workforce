import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { countPlanAwaiting, isPlanAwaitingOverdue } from "@/lib/approvals-hub/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Weekly / Monthly Plan Approvals" sidebar link — actionable-now items only.
// `overdue` drives the badge's graduated urgency (red vs. orange pump) once any awaiting item
// breaches its SLA — see APPROVALS_SLA_THRESHOLDS.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_plans", "read");
    const [count, overdue] = await Promise.all([countPlanAwaiting(access), isPlanAwaitingOverdue(access)]);
    return NextResponse.json({ count, overdue }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ count: 0, overdue: false });
  }
}
