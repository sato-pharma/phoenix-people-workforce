import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canReadAllProbation } from "@/lib/probation/service";
import { getProbationOutcomesAnalytics } from "@/lib/probation/intelligence/outcomes-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Historical outcomes analytics (E4): aggregate over DECIDED cases. Company-wide read, so gated at
// probation:read and further restricted to company-wide probation readers (CEO / HR / Training / MM).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");
    if (!canReadAllProbation(access)) {
      return NextResponse.json({ error: "Forbidden: probation analytics requires company-wide probation access." }, { status: 403 });
    }
    const analytics = await getProbationOutcomesAnalytics();
    return NextResponse.json(analytics, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: String(error) }, { status: 403 });
    return NextResponse.json({ error: String((error as { message?: unknown })?.message ?? error) }, { status: 500 });
  }
}
