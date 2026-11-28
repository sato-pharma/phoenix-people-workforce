import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { readTestFlag, resolvePhoenixCrmViewer, territoryForDayWrite } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadConferenceCompanionChoices } from "@/lib/private-calendar/conference-companions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = who from his line a rep can name on today's whole-day Conference (owner, 2026-11-28: "ask the rep").
// The same writer gate as the day's save (territoryForDayWrite): only the person who may record the day is
// offered the list. A test account is offered nobody — its names would never be written.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const { seat, isTest } = territoryForDayWrite(viewer, search.get("seatId"), readTestFlag(search.get("test")));
    const people = isTest ? [] : await loadConferenceCompanionChoices(seat.lineCode, seat.occupantHrId ?? viewer.hrId);
    return NextResponse.json({ people, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the line's people.");
  }
}
