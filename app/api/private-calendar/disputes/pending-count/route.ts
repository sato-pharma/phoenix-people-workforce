import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { listPendingPrivateCalendarDataDisputes } from "@/lib/private-calendar/disputes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Calendar Disputes" sidebar row, which became its own inbox on 2026-10-08.
// It is the LENGTH of exactly the list that inbox renders, so the number and the page can never
// disagree. A role that cannot review one (anybody but Super Admin — assertDisputeDecisionActor
// refuses) falls back to 0, exactly as every other badge endpoint here does, so no refusal reaches
// the 30 s poll.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const disputes = await listPendingPrivateCalendarDataDisputes(access);
    return NextResponse.json({ count: disputes.length }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
