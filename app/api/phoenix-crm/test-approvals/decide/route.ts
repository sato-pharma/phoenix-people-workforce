import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { decideTestApproval } from "@/lib/phoenix-crm/server/test-approvals";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = one step on one TEST entry, taken by the Super Admin from his "Test accounts" tab (owner,
// 2026-10-22). The service refuses anybody else and any real row, and sends the step through the very
// decider the real screens use.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const decided = await decideTestApproval(viewer, body);
    return NextResponse.json({ decided, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision on the test entry.");
  }
}
