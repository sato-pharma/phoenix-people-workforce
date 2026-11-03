import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { sendNewHireAccount } from "@/lib/new-hire-accounts/service";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { trustedOriginForRedirect } from "@/lib/security/origins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = one setup link to one person. The Super Admin's and the SFE Manager's (owner, 2026-11-03). `approve` because the
// SFE Manager holds neither `update` nor `user_admin`; the service refuses every other holder of `approve`, and anybody
// who is not a new hire waiting to set a password. The link's origin is the allow-listed one, never a forwarded host.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const result = await sendNewHireAccount(viewer, body, { actorLoginId: access.loginId ?? null, origin: trustedOriginForRedirect(request) });
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not send this account.");
  }
}
