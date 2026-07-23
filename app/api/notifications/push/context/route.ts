import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Minimal endpoint the OneSignal client provider calls once per mount to learn which
// HR_ID to OneSignal.login() as. Exposing a user's own HR_ID to their own authenticated
// session is not sensitive (it's already visible throughout their own portal) — this
// route exists only because NEXT_PUBLIC_ env vars can't carry the caller's identity.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    // Uppercased to match src/lib/notifications/system.ts's cleanHrId() convention — that's
    // the exact form the server later sends the push to (include_aliases.external_id) and
    // the form push_subscriptions.hr_id is stored/queried in. OneSignal External IDs are
    // case-sensitive, so OneSignal.login() must use the identical form or a real user with
    // a non-uppercase stored hr_id would silently never receive anything.
    const hrId = access.hrId ? access.hrId.trim().toUpperCase() : null;
    return NextResponse.json({ data: { hrId }, success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = error instanceof Error ? error.message : "Unable to resolve push context.";
    return NextResponse.json({ error: "push_context_failed", message }, { status: 500 });
  }
}
