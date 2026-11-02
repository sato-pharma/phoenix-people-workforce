import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { startServerTimer } from "@/lib/http/server-timing";
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
  // Server-Timing (durations only): access, viewer and load — the same three stages as the List, so a
  // slow prep is read in the network panel and the process-health line (2 Nov 2026, Stage 2).
  const timer = startServerTimer("crm_call_prep");
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    timer.lap("access");
    const viewer = await timer.measure("viewer", () => resolvePhoenixCrmViewer(access));
    const search = searchOf(request);
    const prep = await timer.measure("load", () => loadCallPrep(viewer, { seatId: search.get("seatId"), test: search.get("test") }));
    return NextResponse.json({ prep, success: true }, { headers: timer.headers() });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load tomorrow's stops.");
  }
}
