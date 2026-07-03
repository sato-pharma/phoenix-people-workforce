import { NextResponse } from "next/server";

import { getSettlementDashboard } from "@/lib/attendance/settlement-dashboard";
import { assertAttendanceSetupPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "read");

    const url = new URL(request.url);
    const cycleKey = url.searchParams.get("cycleKey") ?? undefined;
    return NextResponse.json(await getSettlementDashboard(cycleKey));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Settlement dashboard failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
