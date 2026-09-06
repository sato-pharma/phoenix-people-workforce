import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { marketAwarenessErrorResponse } from "@/lib/market-awareness/api-response";
import { createActivity, listActivities } from "@/lib/market-awareness/service";
import type { MarketAwarenessStatus } from "@/lib/market-awareness/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const status = new URL(request.url).searchParams.get("status");
    const activities = await listActivities(access, {
      status: (status as MarketAwarenessStatus | null) ?? null,
    });
    return NextResponse.json({ activities, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not load awareness activities.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const activity = await createActivity(access, await request.json());
    return NextResponse.json({ activity, success: true });
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not create the awareness activity.");
  }
}
