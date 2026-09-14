import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isPortalSosActionsRole } from "@/lib/sales/portal-sos-dashboard";
import { loadPortalMonthPace } from "@/lib/sales/sos-month-pace-loader";
import { loadPortalPharmacyActions } from "@/lib/sales/sos-pharmacy-actions-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Read-only feed for the pharmacy action lists and the weekly month-pace strip on the portal Source
// of Sales page. Scope is resolved from the SESSION; the only query parameter is the line the viewer
// picked, and pickPortalClosingLine refuses a line outside his scope rather than substituting one.

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    if (!isPortalSosActionsRole(access.role)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const requestedLine = searchParams.get("line")?.trim() || null;

    const data = await loadPortalPharmacyActions({ access, requestedLine });

    // The pace strip needs a line, and a rep needs his area — without it he would be measured against
    // nothing, so it is simply not shown. Weekly failing never takes the action lists down with it.
    const canPace = Boolean(data.line) && (access.role !== "Medical Rep" || Boolean(data.areaCodes?.length));
    const pace = canPace && data.line
      ? await loadPortalMonthPace({
          access,
          line: data.line,
          areaCodes: data.areaCodes,
          productCodes: data.productCodes,
        }).catch(() => null)
      : null;

    return NextResponse.json({ success: true, data, pace });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to load your pharmacy actions.") },
      { status: 500 },
    );
  }
}
