import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { cancelVisitAsk } from "@/lib/phoenix-crm/server/visit-asks";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the rep takes back an ask still waiting (owner, 2026-10-02). `create`, the rep's own work, and
// narrowed in the service to the territory's own rep, in the ask's own world — the ask is read from
// its row, never from this body. An answered ask stays as it was answered. Nobody is told; the waiting
// notices are withdrawn.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const asks = await cancelVisitAsk(viewer, body);
    return NextResponse.json({ asks, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not cancel the ask.");
  }
}
