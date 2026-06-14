import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { createSystemNotification } from "@/lib/notifications/system";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    const result = await createSystemNotification({
      actionUrl: "/employee-portals/profile",
      actorId: access.loginId ?? access.hrId ?? "system",
      channels: ["telegram", "in_app"],
      eventType: "telegram_test",
      message: "Phoenix Telegram notifications are connected.",
      metadata: { test: true },
      module: "system",
      priority: "normal",
      recipientHrId: access.hrId,
      recipientUserId: access.loginId,
      title: "Telegram test notification",
    });
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = error instanceof Error ? error.message : "Unable to send Telegram test notification.";
    return NextResponse.json({ error: "telegram_test_failed", message }, { status: 500 });
  }
}
