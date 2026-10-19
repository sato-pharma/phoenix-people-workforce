import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { decideValidationReview } from "@/lib/phoenix-crm/server/validation-reviews";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = approve or reject a place the Google Maps check could not confirm. The Super Admin and the SFE Manager (owner,
// 2026-10-03: "only system admin can approve or reject"; widened 2026-10-19): `approve` here is gate one, and the service
// refuses everyone but those two before anything is read (`canDecideValidationReviews`).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const decided = await decideValidationReview(viewer, await request.json());
    return NextResponse.json({ decided, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision.");
  }
}
