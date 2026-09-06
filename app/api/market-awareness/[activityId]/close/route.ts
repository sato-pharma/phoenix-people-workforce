import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { marketAwarenessErrorResponse } from "@/lib/market-awareness/api-response";
import { closeActivity } from "@/lib/market-awareness/service";
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
    // `undefined` and `null` mean different things here: an absent key leaves the stored value
    // alone, null clears it. An optional field written unconditionally is a silent erase.
    const activity = await closeActivity(access, activityId, {
      actualCost: "actualCost" in body ? body.actualCost : undefined,
      executedAt: body.executedAt ?? null,
      outcomeNote: "outcomeNote" in body ? body.outcomeNote : undefined,
    });
    return NextResponse.json({ activity, success: true });
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not close that awareness activity.");
  }
}
