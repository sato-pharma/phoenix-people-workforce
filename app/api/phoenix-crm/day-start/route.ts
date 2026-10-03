import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDayStart, startDay } from "@/lib/phoenix-crm/server/day-start";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  = whether this territory's rep has confirmed he started, on one day.
// POST = the rep presses "Show your manager you started working": the server's own clock stamps it,
//        his position rides with it, and his district manager and the SFE Manager are told once.
//        The service narrows the write to the territory's OWN rep.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const dayStart = await loadDayStart(viewer, {
      seatId: search.get("seatId"),
      test: search.get("test"),
      date: search.get("date"),
    });
    return NextResponse.json({ dayStart, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not read the day's start.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as { seatId?: unknown; test?: unknown; lat?: unknown; lon?: unknown; accuracyMeters?: unknown };
    const result = await startDay(viewer, {
      accuracyMeters: body?.accuracyMeters,
      lat: body?.lat,
      lon: body?.lon,
      seatId: body?.seatId,
      test: body?.test,
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "That did not save. Try again.");
  }
}
