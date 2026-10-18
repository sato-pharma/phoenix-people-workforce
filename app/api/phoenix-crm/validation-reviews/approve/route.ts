import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { approveValidatedPlace } from "@/lib/phoenix-crm/server/validation-reviews";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = confirm a validation the system could not read (owner, 2026-10-17: "make me able to approve").
// The Super Admin ALONE, exactly as the refusal beside it: `update` here is gate one, and the service
// refuses everyone but the Super Admin before anything is read.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const approved = await approveValidatedPlace(viewer, await request.json());
    return NextResponse.json({ approved, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not approve the validation.");
  }
}
