import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDayActivities, saveDayActivity } from "@/lib/phoenix-crm/server/day-activities";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  = a territory's day activities over a span, for anyone who reads the territory.
// POST = write or clear TODAY's, for the territory's own rep.
//
// A manager enters a VISIT on a rep's territory — he was there, with him — but never a day activity,
// which is a statement about how the rep spent his own day. The date is the server's Cairo today and
// is never taken from the body: back-dating a day activity is the same hole as back-dating a visit.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const activities = await loadDayActivities(viewer, {
      from: search.get("from"),
      seatId: search.get("seatId"),
      test: search.get("test"),
      to: search.get("to"),
    });
    return NextResponse.json({ activities, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the day activities.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as Parameters<typeof saveDayActivity>[1];
    const saved = await saveDayActivity(viewer, body);
    return NextResponse.json({ saved, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the day activity.");
  }
}
