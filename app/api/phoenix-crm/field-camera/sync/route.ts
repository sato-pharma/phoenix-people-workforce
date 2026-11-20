import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { captureClientOf } from "@/lib/phoenix-crm/server/capture-client";
import { syncFieldCameraVisit } from "@/lib/phoenix-crm/server/field-camera-sync";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = one Phoenix Camera visit, synced when the phone has network again: the sealed photo validates a customer
// with no place, and the visit is saved dated by the seal's offline clock. A resend of the same visit is the same
// visit. The app's alone (a bearer token, no session cookie); a browser is answered 404.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const result = await syncFieldCameraVisit(viewer, body, captureClientOf(request.headers));
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not record the visit.");
  }
}
