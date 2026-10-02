import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { upsertPushSubscription } from "@/lib/notifications/settings";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deviceTypes = new Set(["desktop", "mobile", "unknown"]);

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    const body = await request.json().catch(() => ({}));
    const deviceType = deviceTypes.has(body.deviceType) ? body.deviceType : "unknown";
    const result = await upsertPushSubscription(access, {
      deviceType,
      onesignalSubscriptionId: String(body.onesignalSubscriptionId ?? ""),
      optedIn: body.optedIn === true,
      userAgent: typeof body.userAgent === "string" ? body.userAgent.slice(0, 300) : null,
    });
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      // The refusal's own sentence, not a bare code. For a test account that sentence IS the
      // explanation ("only Phoenix CRM saves, and only as test entries"), and a browser handed
      // `{error:"forbidden"}` has nothing to show the person. clientSafeErrorMessage still keeps a
      // fault's internals out of the response.
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "This account cannot register for push.") },
        { status: 403 },
      );
    }
    // A 500 here used to leave NO trace at all. The route catches its own error, so Next's
    // onRequestError never fires and nothing reaches app_error_events; and nothing in this file
    // logged. The single 500 production served on 02 Oct 2026 at 19:12:11 Cairo was readable only in
    // Railway's HTTP log, which keeps about twelve minutes.
    logError("Push subscription registration failed", {
      labels: { event: "push_register_failed", route: "/api/notifications/push/register" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Unable to register push subscription.");
    return NextResponse.json({ error: "push_register_failed", message }, { status: 500 });
  }
}
