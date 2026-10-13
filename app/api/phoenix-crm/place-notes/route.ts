import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { savePlaceNote } from "@/lib/phoenix-crm/server/place-notes";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = write one comment on a place check, with the writer's own choice of whether the rep may read
// it (owner, 2026-10-13).
//
// `approve` is gate one DELIBERATELY, not `update`: a District Manager holds
// phoenix_crm ["read", "create", "approve"] and no `update` at all, so `update` here would 403 the one
// person this route exists for. Gate two is the service — `savePlaceNote` admits the Super Admin and a
// district manager on his OWN team's seats, and refuses the RSM, the NSM and the SFE Manager, who all
// hold `approve` too. It decides nothing: the decision stays `canDecideValidationReviews`.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const note = await savePlaceNote(viewer, await request.json());
    return NextResponse.json({ note, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the comment.");
  }
}
