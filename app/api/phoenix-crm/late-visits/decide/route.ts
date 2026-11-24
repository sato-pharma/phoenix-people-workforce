import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { decideLateVisit } from "@/lib/phoenix-crm/server/late-visits";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Super Admin approves or rejects a filed late visit (owner, 24 Nov 2026: "SUPER ADMIN APPROVE IT ONLY SUPER
// ADMIN"). `update` at the door, narrowed again in the service to him alone (`canEnterMissedRecords`).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const body = (await request.json()) as Record<string, unknown>;
    const viewer = await resolvePhoenixCrmViewer(access);
    const decided = await decideLateVisit(viewer, body);
    return NextResponse.json({ decided, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision.");
  }
}
