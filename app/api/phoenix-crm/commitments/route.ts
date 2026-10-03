import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadRepCommitments } from "@/lib/phoenix-crm/server/commitments";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the rep's own open commitments on one territory: what he said he would do at a visit and has
// not been back for (src/lib/phoenix-crm/commitments.ts).
//
// READ ONLY, and there is no POST on purpose: a commitment is closed by going back to the customer,
// never by a tick. A completion input would be a step added to the rep's day, and adding any step
// needs the owner's word first (Golden rule #1, the EASY half).
//
// The territory gate is inside `loadRepCommitments` — the rep's own seat, nobody else's.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const commitments = await loadRepCommitments(viewer, { seatId: search.get("seatId"), test: search.get("test") });
    return NextResponse.json({ commitments, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load what you said you would do.");
  }
}
