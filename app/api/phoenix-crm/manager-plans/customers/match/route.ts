import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { matchManagerCustomer } from "@/lib/phoenix-crm/server/manager-customers";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the customers already on his reps' lists or his own under the name he is typing, so he can pick
// the existing one. A READ sent as a POST (a typed name does not belong in a URL), audited as a read.
// `read`, like his own add it is the first half of, and narrowed in the service to him.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const matches = await matchManagerCustomer(viewer, body);
    return NextResponse.json({ matches, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not look the name up.");
  }
}
