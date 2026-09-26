import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { decideUnplannedVisit } from "@/lib/phoenix-crm/server/unplanned";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = approve or refuse an off-plan visit (a refusal carries a note). There is no GET: the queue
// rides in /api/phoenix-crm/team beside the grade and drop requests, so one decision refreshes the
// whole Team tab. Which STEP the decision is — the territory's manager, or the SFE — is read from the
// row inside the service, never from this body, and narrowed again by assertUnplannedVisitApprover.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const decided = await decideUnplannedVisit(viewer, body);
    return NextResponse.json({ success: true, visit: decided });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision.");
  }
}
