import { NextResponse } from "next/server";

import { handleSiRequest } from "@/lib/sales/intelligence/request";
import { getSiDailyCurve } from "@/lib/sales/intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  // Day grain must be month-bounded — "all"/empty is rejected, never scanned.
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "";
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ success: false, error: "A concrete YYYY-MM period is required." }, { status: 400 });
  }
  return handleSiRequest(request, (scope) => getSiDailyCurve(period, scope));
}
