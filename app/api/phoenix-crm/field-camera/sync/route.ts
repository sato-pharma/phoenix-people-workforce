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

// POST = one Phoenix Camera item (a visit, a validation or a new customer), sent when the phone has network again.
// Recorded at once when every rule allows it, otherwise kept for the Super Admin's camera page; the phone is told
// "received" either way (server/camera-items.ts). A resend of the same item is the same item. The app's alone (a
// bearer token, no session cookie); a browser is answered 404.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const result = await syncFieldCameraVisit(viewer, body, captureClientOf(request.headers));
    return NextResponse.json({ result, status: result.status, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not record the visit.");
  }
}
