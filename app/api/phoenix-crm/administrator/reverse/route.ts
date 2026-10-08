import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { reverseDecision } from "@/lib/phoenix-crm/server/administrator-reversals";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the Administrator takes back a decision that was already taken: a reopened week closes again,
// an approved off-plan visit stops counting, an approved list request is undone (owner, 2026-10-08). The
// comment is required and the rep reads it. WHO may do it is `canOverrideDecision` inside the service —
// the Administrator on a real entry and nobody else — and WHAT can still be put back is the database
// function's call, never the screen's.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const reversed = await reverseDecision(viewer, body);
    return NextResponse.json({ reversed, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not reverse the decision.");
  }
}
