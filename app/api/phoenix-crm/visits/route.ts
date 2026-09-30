import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadVisitDay, saveVisit } from "@/lib/phoenix-crm/server/visits";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  = one territory's visits on one day (today by default), for anyone who reads the territory.
// POST = save one visit: the territory's rep, or a manager of the territory (their own visit). A resend
//        of the same visit id answers with the saved visit.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const day = await loadVisitDay(viewer, { seatId: search.get("seatId"), test: search.get("test"), date: search.get("date") });
    return NextResponse.json({ day, success: true });
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
    const visit = await saveVisit(viewer, body);
    // 🔴 DO NOT ADD `revalidatePath("/employee-portals")` HERE. It was added on 2026-09-30 to make
    // the rep's day go green when he presses Back from this form, and MEASURED not to: that page is
    // `force-dynamic`, so there is no server cache to invalidate — the stale copy is the browser's
    // own router cache, and only `router.refresh()` in visit-log-form.tsx empties it.
    return NextResponse.json({ visit, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the visit.");
  }
}
