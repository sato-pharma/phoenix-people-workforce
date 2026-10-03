import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadCallPrep } from "@/lib/phoenix-crm/server/call-prep";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = what the rep wants to know before the door, for his planned stops on the next day a plan can
// hold (src/lib/phoenix-crm/call-prep.ts): when he last saw each customer, what was pushed back on,
// what he said he would do, and what he discussed.
//
// READ ONLY, and there is no POST on purpose: the plan is weekly and a SENT week changes only through
// "Ask to edit this week" — the district manager, then SFE, then HR (owner, 2026-10-01). Nothing on
// this path may become a second door into that one.
//
// The territory gate is inside `loadCallPrep` — the rep's own seat, nobody else's.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const prep = await loadCallPrep(viewer, { seatId: search.get("seatId"), test: search.get("test") });
    return NextResponse.json({ prep, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load tomorrow's stops.");
  }
}
