import { NextResponse } from "next/server";

import {
  emailNotificationsEnabled,
  sendNotificationEmail,
} from "@/lib/notifications/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: Request) {
  if (process.env.NOTIFICATION_TEST_MODE === "true") return true;

  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  return request.headers.get("x-cron-secret") === secret;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
}
