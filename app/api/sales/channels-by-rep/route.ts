import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadChannelsByRep } from "@/lib/sales/channels-by-rep";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Feeds the Channels by Rep tab: Hospital / Store / Pharmacy sales for each rep seat. Same gate as
// the Customers tab it sits beside — the role check here IS the security boundary; the tab being
// hidden in the UI is not one.
//
// `reveal` is a REQUEST, not a decision. loadChannelsByRep runs it past canViewRestrictedProducts,
// so a non-CEO passing ?reveal=1 changes nothing. Keeping the resolution server-side is the whole
// point: those three products are 81.5% of sales value, and this is the query that would leak them.
//
// `period` is a month, or `all` for the whole history. Without it the read covers the newest published
// closing, so only a request that names the whole history pays for it (resolveChannelsByRepPeriod).

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Channels by Rep is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "import");

    const { searchParams } = new URL(request.url);
    const reveal = searchParams.get("reveal");

    const data = await loadChannelsByRep({
      period: searchParams.get("period"),
      revealRestricted: reveal === "1" || reveal === "true",
      role: access.role,
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: clientSafeErrorMessage(error, "Failed to load Channels by Rep."),
      },
      { status: 500 },
    );
  }
}
