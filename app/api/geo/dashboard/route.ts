import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { getGeoDashboardData } from "@/lib/geo-intelligence/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "geo_intelligence", "read");

    const url = new URL(request.url);
    const data = await getGeoDashboardData(access, {
      area: url.searchParams.get("area"),
      employeeHrId: url.searchParams.get("employeeHrId"),
      line: url.searchParams.get("line"),
      month: url.searchParams.get("month"),
      status: (url.searchParams.get("status") ?? "") as
        | "normal"
        | "review_required"
        | "high_risk"
        | "",
    });

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load geo dashboard.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "geo_dashboard_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
