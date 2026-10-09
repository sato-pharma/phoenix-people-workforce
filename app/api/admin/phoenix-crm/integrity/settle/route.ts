import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { settleIntegrityCase } from "@/lib/phoenix-crm/server/integrity-board";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the Super Admin settles one location-integrity case, with his reason. `update` here is gate
// one; the service refuses everyone but the Super Admin before it reads anything
// (`canSettleIntegrityCases`), so the SFE Manager — who READS this board — cannot settle on it.
//
// Nothing is deleted and nobody is notified: no rep is ever told he was flagged, so no rep can be
// told a flag about him was closed.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const settled = await settleIntegrityCase(viewer, await request.json());
    return NextResponse.json({ settled, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not settle this case.");
  }
}
