import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { moveCustomerToSeat } from "@/lib/phoenix-crm/server/list";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the SFE Manager hands a customer from one rep's list to another's, with a written reason
// (owner, 2026-10-06: "or move this customer to and choose where"). The customer travels whole — his
// grade, his potential, his validation and his clinics — because a validated place is fixed forever
// and belongs to the customer, not to the rep. The SFE Manager and the Super Admin (`canCurateList`),
// and only to a seat the viewer already reaches.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const moved = await moveCustomerToSeat(viewer, body);
    return NextResponse.json({ moved, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not move the customer.");
  }
}
