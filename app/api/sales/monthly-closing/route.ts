import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadMonthlyClosing } from "@/lib/sales/monthly-distributor-import";
import { loadMonthlySourceCoverage } from "@/lib/sales/source-coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);

    // Phase 1 is reserved for the admin account. Server-side enforcement — the sidebar
    // link is UX only, never the boundary.
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Monthly Closing is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "import");

    const { searchParams } = new URL(request.url);
    const line = searchParams.get("line");
    const period = searchParams.get("period");
    const data = await loadMonthlyClosing({ line, period });
    // Completeness ride-along: which of last month's sources are still absent from this month.
    // Degrades to null — the banner simply hides — rather than ever taking the closing down.
    const coverage = await loadMonthlySourceCoverage(data.line, data.period).catch(() => null);

    return NextResponse.json({ success: true, data, coverage });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load Monthly Closing.",
      },
      { status: 500 },
    );
  }
}
