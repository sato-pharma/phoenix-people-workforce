import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  applyAdminPhotoValidation,
  armAdminPhotoValidation,
  cancelAdminPhotoValidation,
  loadAdminPhotoState,
  rewatchAdminPhotoValidation,
} from "@/lib/phoenix-crm/server/admin-photo";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { validationError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Super Admin validates a customer for a rep with a photo HE uploads, the location being the rep's own live
// reading taken while his watch is on (owner, 2026-11-20: "make a button for me to press on watch the rep while
// capturing location"). The coarse verb is `update`, as on the trusted point; the service repeats the gate with
// `canValidateWithAdminPhoto` (the Super Admin alone, never a test persona) before anything is read.

// GET = the customer, why he cannot be validated (if so), and the open watch with the rep's reading.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const state = await loadAdminPhotoState(viewer, searchOf(request).get("customerId"));
    return NextResponse.json({ state, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not read this customer's photo validation.");
  }
}

// POST = one step: "arm" (upload the photo and watch the rep), "rewatch", "cancel" or "apply" (validate).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    switch (body?.action) {
      case "arm":
        return NextResponse.json({ state: await armAdminPhotoValidation(viewer, body), success: true });
      case "rewatch":
        return NextResponse.json({ state: await rewatchAdminPhotoValidation(viewer, body.validationId), success: true });
      case "cancel":
        return NextResponse.json({ state: await cancelAdminPhotoValidation(viewer, body.validationId), success: true });
      case "apply":
        return NextResponse.json({ applied: await applyAdminPhotoValidation(viewer, body.validationId), success: true });
      default:
        throw validationError("Reload the page and try again.");
    }
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save this photo validation.");
  }
}
