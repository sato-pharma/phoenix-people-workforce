import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { restoreValidation } from "@/lib/phoenix-crm/server/validation-reviews";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = approve a place AFTER it was rejected (owner, 2026-10-03: "add the option to approve after
// reject"). The Super Admin ALONE since 2026-11-10 ("the SFE cannot"): `approve` here is gate one, and the
// service (`canRestoreValidation`) refuses everyone but the Super Admin before anything is read.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const restored = await restoreValidation(viewer, await request.json());
    return NextResponse.json({ restored, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not bring this place back.");
  }
}
