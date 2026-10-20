import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { decideSingleVisitDay } from "@/lib/phoenix-crm/server/manager-single-visit-days";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = his ask for a day of single visits, approved (or passed on) or refused. `read`, narrowed in the
// service to the approver stored on the ask for its step (`managerAskDeciderRole`), or the Administrator in
// his place.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const ask = await decideSingleVisitDay(viewer, body);
    return NextResponse.json({ ask, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision on the day of single visits.");
  }
}
