import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { uploadPhotoDirect } from "@/lib/phoenix-crm/server/photos";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the native app's live photo: the phone sends the stamped JPEG as a base64 data URL and the
// server issues the one-time slot and puts the bytes in the private bucket. It is the counterpart of
// `/photos/upload-slot` + the browser's direct PUT, for a client that cannot PUT binary to a signed
// URL (no expo-file-system in this build). Same `create` gate; the CSRF check exempts the native app
// through the `x-phoenix-client` header, as every Phoenix CRM write does. Returns `{ path, issuedAt }`,
// which a later save consumes exactly as it does a browser upload.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const photo = await uploadPhotoDirect(viewer, body);
    return NextResponse.json({ photo, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not upload the photo.");
  }
}
