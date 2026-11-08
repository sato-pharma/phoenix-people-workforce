import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { decideHeldFullName } from "@/lib/phoenix-crm/server/full-name-reviews";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = approve or reject a PM customer's full name that matched the board under 60% (owner, 2026-11-07).
// `approve` here is gate one; the service refuses everyone but the Super Admin and the SFE Manager
// (`canDecideValidationReviews`) before anything is read. A CORRECTED name (`nameParts`, owner 2026-11-08) is the
// Super Admin's alone: the service refuses it from anybody without `update` (`canCorrectHeldFullName`) before the
// database is called. One permission per route is this module's rule (tests/phoenix-crm-boundary.test.ts).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const decided = await decideHeldFullName(viewer, await request.json());
    return NextResponse.json({ decided, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision.");
  }
}
