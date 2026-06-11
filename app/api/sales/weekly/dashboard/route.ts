import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "read");

    const params = new URL(request.url).searchParams;
    const str = (key: string) => {
      const value = params.get(key);
      return value && value.trim() ? value.trim() : null;
    };
    const data = await loadWeeklyDashboard({
      weekStart: str("week"),
      distributorCode: str("distributor"),
      regionCode: str("region"),
      productCode: str("product"),
      viewerRole: access.role,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load the weekly dashboard." },
      { status: 500 },
    );
  }
}
