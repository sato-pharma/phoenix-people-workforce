import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { setRepException } from "@/lib/phoenix-crm/server/rep-exceptions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = one switch or one change of dates for one rep. The Super Admin's alone (owner, 2026-11-03: "for admin
// only"); the service refuses everybody else.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const result = await setRepException(viewer, body);
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not change this rep's exception.");
  }
}
