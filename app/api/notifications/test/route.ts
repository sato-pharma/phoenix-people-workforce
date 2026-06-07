import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { systemIdentity } from "@/config/system-settings";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { emailNotificationsEnabled } from "@/lib/notifications/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");

    if (!emailNotificationsEnabled()) {
      return NextResponse.json({
        enabled: false,
        reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.",
        skipped: true,
      });
    }

    const body = await request.json().catch(() => ({}));
    const recipients = Array.isArray(body.to)
      ? body.to.map(String)
      : typeof body.to === "string"
        ? [body.to]
        : [];

    if (recipients.length === 0) {
      return NextResponse.json({ error: "Missing 'to' field." }, { status: 400 });
    }

    const subject = `${systemIdentity.brandName} email notifications test`;
    const text = `This is a live test email from ${systemIdentity.appName}. If you received this, email delivery is working.`;
    const html = `<div style="font-family:sans-serif;padding:24px;max-width:480px"><h2 style="color:#f97316">Email Notifications Are Online</h2><p>${text}</p><p style="color:#888;font-size:12px">Environment: ${process.env.NODE_ENV ?? "unknown"}</p></div>`;

    const result = await sendPhoenixEmail({
      html,
      idempotencyKey: `test-${randomUUID()}`,
      subject,
      text,
      to: recipients,
    });

    return NextResponse.json({
      enabled: true,
      result,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const message = error instanceof Error ? error.message : "Notification test failed.";
    return NextResponse.json({ error: "notification_test_failed", message }, { status: 500 });
  }
}
