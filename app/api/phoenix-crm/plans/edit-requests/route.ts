import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { raisePlanEdit } from "@/lib/phoenix-crm/server/plan-edits";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the rep asks to edit a week he already sent (owner, 2026-10-01). One button, no reason. The
// request then runs the district manager → SFE → HR at /plans/edit-requests/decide, under `approve`,
// so neither route carries the other; the queue rides in /api/phoenix-crm/team.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const raised = await raisePlanEdit(viewer, body);
    return NextResponse.json({ request: raised, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not send the request.");
  }
}
