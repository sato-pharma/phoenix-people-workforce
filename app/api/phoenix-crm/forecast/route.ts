import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadForecastForm, saveForecast } from "@/lib/phoenix-crm/server/daily-forecast";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  = today's forecast form for one CNS territory: the territory's own rep (or the Super Admin in test mode).
// POST = send or re-send it, for the territory's own rep.
//
// The day is the server's visit day and is never taken from the body, and the pre-filled boxes are
// recomputed on the server from the month's target: the screen sends only what the rep typed.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const form = await loadForecastForm(viewer, { seatId: search.get("seatId"), test: search.get("test") });
    return NextResponse.json({ form, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the daily forecast.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as Parameters<typeof saveForecast>[1];
    const form = await saveForecast(viewer, body);
    return NextResponse.json({ form, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not send the daily forecast.");
  }
}
