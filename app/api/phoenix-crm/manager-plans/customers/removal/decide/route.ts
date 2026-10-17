import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { decideManagerCustomerRemoval } from "@/lib/phoenix-crm/server/manager-customers";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = taking a customer off his own list, approved or refused. `read`, narrowed in the service to the
// approver stored on the ask for its step (`managerAskDeciderRole`), or the Administrator in his place.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const customer = await decideManagerCustomerRemoval(viewer, body);
    return NextResponse.json({ customer, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision.");
  }
}
