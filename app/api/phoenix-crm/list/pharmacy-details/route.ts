import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { setPharmacyDetails } from "@/lib/phoenix-crm/server/list";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = set or correct a pharmacy's own location and its responsible person's phone (owner,
// 2026-10-09), on one already on his list. Both optional, both corrected the same way: absent means
// leave it, null means clear it. The territory's own rep only, and the geography behind the pin is
// resolved on the server from the coordinate.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const result = await setPharmacyDetails(viewer, body);
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the pharmacy's details.");
  }
}
