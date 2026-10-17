import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { raiseManagerPlanEdit } from "@/lib/phoenix-crm/server/manager-plans";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = he asks to edit a week he already sent. `create`, narrowed in the service to his OWN week; his
// RSM/NSM decides it at edit-requests/decide.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const ask = await raiseManagerPlanEdit(viewer, body);
    return NextResponse.json({ ask, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not send the ask to edit.");
  }
}
