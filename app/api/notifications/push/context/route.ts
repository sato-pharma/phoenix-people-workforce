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
    return NextResponse.json({ data: { hrId: access.hrId ?? null }, success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = error instanceof Error ? error.message : "Unable to resolve push context.";
    return NextResponse.json({ error: "push_context_failed", message }, { status: 500 });
  }
}
