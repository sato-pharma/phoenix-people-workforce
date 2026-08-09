import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { upsertPushSubscription } from "@/lib/notifications/settings";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = clientSafeErrorMessage(error, "Unable to register push subscription.");
    return NextResponse.json({ error: "push_register_failed", message }, { status: 500 });
  }
}
