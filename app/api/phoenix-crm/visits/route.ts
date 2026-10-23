import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { startServerTimer } from "@/lib/http/server-timing";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { captureClientOf } from "@/lib/phoenix-crm/server/capture-client";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadVisitDay, saveVisit } from "@/lib/phoenix-crm/server/visits";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  = one territory's visits on one day (today by default), for anyone who reads the territory.
// POST = save one visit: the territory's rep, or a manager of the territory (their own visit). A resend
//        of the same visit id answers with the saved visit.
export async function GET(request: Request) {
  const timer = startServerTimer("crm_visits");
  try {
    const access = await resolveAccessContext(request);
    timer.lap("access");
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await timer.measure("viewer", () => resolvePhoenixCrmViewer(access));
    const search = searchOf(request);
    const day = await timer.measure("load", () => loadVisitDay(viewer, { seatId: search.get("seatId"), test: search.get("test"), date: search.get("date") }));
    return NextResponse.json({ day, success: true }, { headers: timer.headers() });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the visits.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    // Which client sent it. It grants nothing and narrows no scope: it decides only whether the body
    // may date this visit from an offline claim, which only the app can honestly make — the web app
    // has no offline queue (src/lib/phoenix-crm/server/capture-client.ts).
    const visit = await saveVisit(viewer, body, captureClientOf(request.headers));
    // 🔴 DO NOT ADD `revalidatePath("/employee-portals")` HERE. It was added on 2026-09-30 to make
    // the rep's day go green when he presses Back from this form, and MEASURED not to: that page is
    // `force-dynamic`, so there is no server cache to invalidate — the stale copy is the browser's
    // own router cache, and only `router.refresh()` in visit-log-form.tsx empties it.
    return NextResponse.json({ visit, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the visit.");
  }
}
