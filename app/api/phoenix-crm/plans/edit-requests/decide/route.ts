import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { decidePlanEdit } from "@/lib/phoenix-crm/server/plan-edits";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = one step of a rep's request to edit a sent week: the district manager approves or refuses,
// then SFE does, then HR acknowledges — which reopens the week (owner, 2026-10-01). Which STEP it is is
// read from the row inside the service, never from this body, and narrowed again by
// assertPlanEditApprover.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const decided = await decidePlanEdit(viewer, body);
    return NextResponse.json({ request: decided, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision.");
  }
}
