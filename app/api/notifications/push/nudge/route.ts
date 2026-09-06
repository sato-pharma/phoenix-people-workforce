import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { dismissPushOptInNudge } from "@/lib/notifications/settings";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dismisses the push opt-in nudge card for the signed-in person, permanently. Same permission as
// PATCH /api/notifications/settings — this is a notification preference like any other, just
// written through its own tiny endpoint so the nudge component doesn't have to know the shape of
// the full settings payload just to flip one flag.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "update");
    const data = await dismissPushOptInNudge(access);
    return NextResponse.json({ data, success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = clientSafeErrorMessage(error, "Unable to dismiss the push notification prompt.");
    return NextResponse.json({ error: "push_opt_in_nudge_dismiss_failed", message }, { status: 500 });
  }
}
