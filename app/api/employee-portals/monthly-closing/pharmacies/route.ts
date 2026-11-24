import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { loadPortalClosingPharmacyCounts, pharmacyCountsForScreen } from "@/lib/sales/closing-pharmacy-counts-loader";
import { canAccessPortalClosing } from "@/lib/sales/monthly-closing-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The Pharmacies column of the portal Monthly Closing — a manager's OWN team, published months only
// (owner's answer, 24 Nov 2026: "Managers, own team"). The same three gates as the page itself:
// canAccessPortalClosing, sales:read, and the viewer's own closing scope inside the loader, which
// also refuses a Medical Rep and an unpublished month.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!canAccessPortalClosing(access)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    await assertPermission(access, "sales", "read");

    const { searchParams } = new URL(request.url);
    const result = await loadPortalClosingPharmacyCounts({
      access,
      line: searchParams.get("line")?.trim() ?? "",
      period: searchParams.get("period")?.trim() ?? "",
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.message }, { status: result.status });
    }
    return NextResponse.json({ success: true, data: pharmacyCountsForScreen(result.counts) });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to count the pharmacies.") },
      { status: 500 },
    );
  }
}
