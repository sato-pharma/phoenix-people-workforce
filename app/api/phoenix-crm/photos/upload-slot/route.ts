import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { requestPhotoSlot } from "@/lib/phoenix-crm/server/photos";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = a one-time upload slot in the private photo bucket, issued to the person about to take the
// live photo: a place photo for the territory's rep, a visit photo for whoever may enter its visits.
// The phone uploads straight to the slot; a later save refuses any path the server did not issue to
// that person.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const slot = await requestPhotoSlot(viewer, body);
    return NextResponse.json({ slot, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not prepare the photo upload.");
  }
}
