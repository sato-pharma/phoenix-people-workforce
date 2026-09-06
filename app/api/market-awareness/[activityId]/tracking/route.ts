import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { marketAwarenessErrorResponse } from "@/lib/market-awareness/api-response";
import { loadActivityTracking } from "@/lib/market-awareness/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ activityId: string }> }) {
  try {
    const { activityId } = await params;
    const access = await resolveAccessContext(request);
    const tracking = await loadActivityTracking(access, activityId);
    return NextResponse.json({ success: true, tracking }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not load the tracking for that activity.");
  }
}
