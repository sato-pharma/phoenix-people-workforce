import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { locateManagerCustomer } from "@/lib/phoenix-crm/server/manager-customers";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = where a captured location is (address, brick, area), so "Add a customer" can fill those fields the
// moment he presses Capture location (owner, 2026-10-17). It writes nothing: a READ sent as a POST (a
// coordinate does not belong in a URL), audited as a read, and `read` like the add it is the first half of.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const located = await locateManagerCustomer(viewer, body);
    return NextResponse.json({ located, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not read the location.");
  }
}
