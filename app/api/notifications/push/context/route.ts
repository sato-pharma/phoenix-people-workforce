import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { onesignalAppId } from "@/lib/notifications/push";
import { pushIdentityOf } from "@/lib/notifications/push-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Minimal endpoint the OneSignal client provider calls once per mount to learn which
// HR_ID to OneSignal.login() as. Exposing a user's own HR_ID to their own authenticated
// session is not sensitive (it's already visible throughout their own portal) — this
// route exists only because NEXT_PUBLIC_ env vars can't carry the caller's identity.
//
// `appId` is for the Android app (mobile/src/lib/push.tsx), which has no build-time copy of
// NEXT_PUBLIC_ONESIGNAL_APP_ID. Reading it from the server keeps ONE source of truth: the phone
// joins whichever OneSignal app the web push already uses, so the server's existing send by
// external ID reaches the phone and the browser alike. It is not a secret — the web SDK ships
// the same value to every browser. The web provider ignores the field.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    // Who gets a push identity, and in which form, is the ONE rule in push-identity.ts.
    const hrId = pushIdentityOf(access);
    return NextResponse.json({ data: { appId: onesignalAppId(), hrId }, success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = clientSafeErrorMessage(error, "Unable to resolve push context.");
    return NextResponse.json({ error: "push_context_failed", message }, { status: 500 });
  }
}
