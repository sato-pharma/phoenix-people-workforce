import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { refuseValidatedPlace } from "@/lib/phoenix-crm/server/validation-reviews";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = refuse a validation the Google check never held (every PM customer, and the AM ones that
// matched). The Super Admin and the SFE Manager, exactly as the held reviews beside it: `approve` here is gate one,
// and the service refuses everyone but those two before anything is read.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const refused = await refuseValidatedPlace(viewer, await request.json());
    return NextResponse.json({ refused, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not refuse the validation.");
  }
}
