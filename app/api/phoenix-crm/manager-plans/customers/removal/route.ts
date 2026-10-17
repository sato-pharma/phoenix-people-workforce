import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { requestManagerCustomerRemoval } from "@/lib/phoenix-crm/server/manager-customers";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = he asks to take a customer off his own list. `create`, narrowed in the service to his own list;
// his RSM/NSM decides it in the Approvals Hub.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const customer = await requestManagerCustomerRemoval(viewer, body);
    return NextResponse.json({ customer, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not send the ask.");
  }
}
