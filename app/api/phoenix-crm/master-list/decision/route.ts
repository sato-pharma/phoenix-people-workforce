import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { saveMasterDecision } from "@/lib/phoenix-crm/server/master-list";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the Super Admin's word on one Master List profile (owner, 2026-10-26: "my click and automatic"):
// confirmed, not confirmed, or cleared, and the place whose photo the profile wears. `update` is gate one;
// the service refuses everyone but the Super Admin before anything is written. No rep's place moves.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const decision = await saveMasterDecision(viewer, await request.json());
    return NextResponse.json({ decision, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save this decision.");
  }
}
