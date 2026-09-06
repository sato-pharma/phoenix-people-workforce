import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { marketAwarenessErrorResponse } from "@/lib/market-awareness/api-response";
import { getActivity, updateActivity } from "@/lib/market-awareness/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ activityId: string }> }) {
  try {
    const { activityId } = await params;
    const access = await resolveAccessContext(request);
    const activity = await getActivity(access, activityId);
    return NextResponse.json({ activity, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not load that awareness activity.");
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ activityId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const { activityId } = await params;
    const access = await resolveAccessContext(request);
    const activity = await updateActivity(access, activityId, await request.json());
    return NextResponse.json({ activity, success: true });
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not update that awareness activity.");
  }
}
