import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { countExcuseAwaiting, isExcuseAwaitingOverdue } from "@/lib/approvals-hub/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Excuse Approvals" sidebar link — actionable-now items only.
// `overdue` drives the badge's graduated urgency (red vs. orange pump) once any awaiting
// item breaches its SLA — see APPROVALS_SLA_THRESHOLDS.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "leave", "read");
    const [count, overdue] = await Promise.all([countExcuseAwaiting(access), isExcuseAwaitingOverdue(access)]);
    return NextResponse.json({ count, overdue }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ count: 0, overdue: false });
  }
}
