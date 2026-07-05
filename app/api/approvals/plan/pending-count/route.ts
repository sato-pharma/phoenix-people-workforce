import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { countPlanAwaiting } from "@/lib/approvals-hub/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Weekly / Monthly Plan Approvals" sidebar link — actionable-now items only.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_plans", "read");
    const count = await countPlanAwaiting(access);
    return NextResponse.json({ count }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
