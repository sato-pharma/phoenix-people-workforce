import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { restoreSharedPlace } from "@/lib/phoenix-crm/server/shared-places";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST ONLY: approve a polyclinic or centre AFTER rejecting it (owner, 2026-10-15: "make me able to
// approve validation after rejection"). It is its own route rather than a third `decision` on the
// sibling POST, for the same reason the place path has `/validation-reviews/restore` beside
// `/validation-reviews`: the rules are different ones — a rejection may be taken back only while the
// venue is still retired — and they belong to a function of their own.
//
// The Super Admin and the SFE Manager, gated in the service by `canDecideValidationReviews` as well as here (`approve` is gate one).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const restored = await restoreSharedPlace(viewer, await request.json());
    return NextResponse.json({ restored, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not bring the polyclinic back.");
  }
}
