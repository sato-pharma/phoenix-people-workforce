import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadMonthlyClosing } from "@/lib/sales/monthly-distributor-import";

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

    return NextResponse.json({ success: true, data });
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
