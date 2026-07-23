import { randomUUID } from "node:crypto";

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
      channels: ["push", "in_app"],
      eventType: "push_test",
      message: "Phoenix push notifications are connected.",
      // eventKeyFor() hashes stable fields (recipient/eventType/module/title) into a
      // deterministic idempotency key when none is given, so every click without a
      // unique key here would collapse onto the SAME event and silently no-op after the
      // first send ("Delivery already sent."). A fresh key per click is what makes a
      // Test Push button actually re-testable.
      metadata: { idempotencyKey: `push-test:${randomUUID()}`, test: true },
      module: "system",
      priority: "normal",
      recipientHrId: access.hrId,
      recipientUserId: access.loginId,
      title: "Push test notification",
    });
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = error instanceof Error ? error.message : "Unable to send push test notification.";
    return NextResponse.json({ error: "push_test_failed", message }, { status: 500 });
  }
}
