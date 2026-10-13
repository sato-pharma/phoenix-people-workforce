import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { savePlaceRecommendation } from "@/lib/phoenix-crm/server/place-notes";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = record, or change, one manager's recommendation on a place check: validate it, or do not
// validate it (owner, 2026-10-13).
//
// 🔴 IT DECIDES NOTHING. No status moves, no place is retired, no customer is reopened, nothing is
// notified, and phoenix_crm_validation_reviews is not touched. The decision is the Super Admin's alone
// (`canDecideValidationReviews`). The same two gates as the comment route beside it, and the same
// reason for `approve` rather than `update`.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const recommended = await savePlaceRecommendation(viewer, await request.json());
    return NextResponse.json({ recommended, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the recommendation.");
  }
}
