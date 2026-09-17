import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { validateCustomer } from "@/lib/phoenix-crm/server/list";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = validate a customer on the territory's list (a reference customer, a new one, or one dropped
// earlier): the live photo, the location taken on the spot and at least one timing. The territory's
// own rep only.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const result = await validateCustomer(viewer, body);
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not validate the customer.");
  }
}
