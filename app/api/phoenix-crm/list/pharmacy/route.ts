import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { addPharmacy } from "@/lib/phoenix-crm/server/list";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = add a pharmacy to his own list by its name (owner, 2026-10-03): no photo, no request and no
// approval — on his list at once. The territory's own rep only.
//
// Its location and its responsible person's phone ride along as OPTIONAL extras in the same save
// (owner, 2026-10-09), never a second step: a body carrying neither behaves exactly as it did.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const result = await addPharmacy(viewer, body);
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not add the pharmacy.");
  }
}
