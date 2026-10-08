import { NextResponse } from "next/server";

import { requireRecruitmentAccess, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { getInboundIntakeAnalytics } from "@/lib/recruitment/inbound/intake-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Inbound-CV funnel analytics for the admin visibility panel: volume, per-channel/outcome
// breakdown, success rate, and the dead-letter count.
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    // Inbound Intake Health is fenced off the Talent Acquisition seat (src/lib/auth/seat-page-fences.ts).
    assertPageOpenForRole(access.role, "/recruitment/intake-health");
    const windowDays = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get("windowDays")) || 30));
    const analytics = await getInboundIntakeAnalytics(windowDays);
    return NextResponse.json({ analytics, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load inbound intake analytics.");
  }
}
