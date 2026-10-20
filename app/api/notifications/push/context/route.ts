import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isReadOnlyViewer } from "@/lib/auth/read-only-viewer";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { onesignalAppId } from "@/lib/notifications/push";

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
    // Uppercased to match src/lib/notifications/system.ts's cleanHrId() convention — that's
    // the exact form the server later sends the push to (include_aliases.external_id) and
    // the form push_subscriptions.hr_id is stored/queried in. OneSignal External IDs are
    // case-sensitive, so OneSignal.login() must use the identical form or a real user with
    // a non-uppercase stored hr_id would silently never receive anything.
    //
    // A test login gets NO push identity: its hrId is the real person it mirrors, and OneSignal.login()
    // with that id would move this device onto HER push user — every notice sent to her would then also
    // ring the test device (src/lib/auth/test-persona.ts; risk review, 2026-09-28). The Super Admin's
    // View as Seat gets none either — the owner's device must never move onto the person he is viewing.
    const hrId = isReadOnlyViewer(access) ? null : access.hrId ? access.hrId.trim().toUpperCase() : null;
    return NextResponse.json({ data: { appId: onesignalAppId(), hrId }, success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = clientSafeErrorMessage(error, "Unable to resolve push context.");
    return NextResponse.json({ error: "push_context_failed", message }, { status: 500 });
  }
}
