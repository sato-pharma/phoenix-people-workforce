import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { placeOnTrustedPoint, previewTrustedPoint } from "@/lib/phoenix-crm/server/trusted-point";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Super Admin validates a customer on the TRUSTED POINT his reps' own readings agree on (owner,
// 2026-11-10: "we will search all locations for this customer in phx crm, then we will compare with the
// locations of checkins of this customer from the old crm until we find a trusted point"). The coarse verb
// is `update`, which the SFE Manager does not decide on here; the service repeats the gate with
// `canPlaceOnTrustedPoint` (the Super Admin alone, never a test account) before anything is read.

// GET = the preview: the point, the readings it stands on, its brick and area — or why there is none.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const preview = await previewTrustedPoint(viewer, searchOf(request).get("customerId"));
    return NextResponse.json({ preview, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not read this customer's trusted point.");
  }
}

// POST = validate on it. The point is computed again on the server; nothing from the browser but the
// customer's id is read.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json().catch(() => null)) as { customerId?: unknown } | null;
    const applied = await placeOnTrustedPoint(viewer, body?.customerId);
    return NextResponse.json({ applied, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not validate this customer on the trusted point.");
  }
}
