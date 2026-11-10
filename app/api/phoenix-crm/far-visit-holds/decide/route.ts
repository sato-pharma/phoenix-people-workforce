import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { decideFarVisitHold } from "@/lib/phoenix-crm/server/far-visit-safeguards";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the SFE's answer on a visit held for him after five far refusals from one spot (owner,
// 2026-11-10): approve (it counts) or refuse (it never counts). The Super Admin and the SFE Manager only;
// the service refuses everyone else before anything is read or written.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const decision = await decideFarVisitHold(viewer, await request.json().catch(() => null));
    return NextResponse.json({ decision, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision.");
  }
}
