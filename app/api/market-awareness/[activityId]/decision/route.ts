import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { marketAwarenessErrorResponse } from "@/lib/market-awareness/api-response";
import { decideActivity } from "@/lib/market-awareness/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ activityId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const { activityId } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const activity = await decideActivity(access, activityId, {
      action: body.action,
      amendedCost: body.amendedCost ?? null,
      comment: body.comment ?? null,
    });
    return NextResponse.json({ activity, success: true });
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not record that decision.");
  }
}
