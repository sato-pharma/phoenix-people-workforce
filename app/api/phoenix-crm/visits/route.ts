import { revalidatePath } from "next/cache";
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
    // 🔴 HIS DAY ON THE LANDING PAGE GOES GREEN THE MOMENT THIS SAVES (owner, 2026-09-30: "if it is
    // submitted from those visits in the overview landing page, it is automatically marked as
    // done"). It already did on a fresh request — but a rep reaches the form from the panel's "+"
    // and comes straight BACK, and the router's own cache served him the page as it stood before he
    // logged the visit: the row still white, the "+" still there, AM still "0 of 1". Measured on the
    // preview box that day. Invalidating the path here is what makes Back show the tick.
    revalidatePath("/employee-portals");
    return NextResponse.json({ visit, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the visit.");
  }
}
