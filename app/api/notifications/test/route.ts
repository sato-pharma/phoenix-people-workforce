import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { systemIdentity } from "@/config/system-settings";
import {
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "@/emails/phoenix-email-layout";
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
    const metadataRows = [{ label: "Environment", value: process.env.NODE_ENV ?? "unknown" }];
    const html = renderPhoenixEmailHtml({
      bodyHtml: renderEmailParagraphs(text),
      metadataRows,
      previewText: text,
      subject,
      subtitle: "Phoenix Workforce email delivery test.",
      title: "Email Notifications Are Online",
    });
    const plainText = renderPhoenixEmailText({
      bodyText: text,
      metadataRows,
      title: "Email Notifications Are Online",
    });

    const result = await sendPhoenixEmail({
      html,
      idempotencyKey: `test-${randomUUID()}`,
      subject,
      text: plainText,
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
