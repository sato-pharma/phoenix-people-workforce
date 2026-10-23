import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canReadAllProbation } from "@/lib/probation/service";
import { getProbationDashboard } from "@/lib/probation/intelligence/dashboard";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CEO exception dashboard: all active probation cases with rollup metrics + risk classification.
// Coarse gate is probation:read; the dashboard shows the WHOLE cohort so it is further restricted
// to company-wide probation readers (CEO / HR / Training Manager / Marketing Manager).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");
    if (!canReadAllProbation(access)) {
      return NextResponse.json({ error: "Forbidden: probation dashboard requires company-wide probation access." }, { status: 403 });
    }
    const dashboard = await getProbationDashboard();
    return NextResponse.json(dashboard, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ error: String((error as { message?: unknown })?.message ?? error) }, { status: 500 });
  }
}
