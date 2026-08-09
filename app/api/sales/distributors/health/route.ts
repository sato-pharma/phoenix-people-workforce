import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getCertificationStatus, getDistributorHealth, readinessFromHealth } from "@/lib/sales/distributor-registry";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only health + readiness for one distributor (mapping coverage, last uploads, readiness band).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const distributor = new URL(request.url).searchParams.get("distributor")?.trim();
    if (!distributor) return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });
    const [health, certification] = await Promise.all([getDistributorHealth(distributor), getCertificationStatus(distributor)]);
    return NextResponse.json({ success: true, health, readiness: readinessFromHealth(health), certification });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to load health.") }, { status: 500 });
  }
}
