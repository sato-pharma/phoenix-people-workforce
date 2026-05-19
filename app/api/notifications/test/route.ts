import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  emailNotificationsEnabled,
  sendNotificationEmail,
} from "@/lib/notifications/email";

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
        : undefined;

    const result = await sendNotificationEmail({
      ctaHref: "/payroll",
      ctaLabel: "Open Phoenix Payroll",
      metrics: [
        { label: "Environment", value: process.env.NODE_ENV ?? "unknown" },
        { label: "Dashboard URL", value: process.env.NOTIFICATION_DASHBOARD_URL ?? "not configured" },
      ],
      recipients,
      subject: "Phoenix email notifications test",
      summary: "This is a live test email from the Phoenix Workforce notification system.",
      title: "Email Notifications Are Online",
      tone: "success",
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
