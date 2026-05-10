import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildEmailNotificationPreview,
  emailNotificationTypes,
  emailRecipientModes,
  getEmailNotificationOutboxStats,
  getEmailNotificationPolicies,
  saveEmailNotificationPolicy,
  type EmailNotificationType,
  type EmailRecipientMode,
} from "@/lib/notifications/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isNotificationType(value: unknown): value is EmailNotificationType {
  return emailNotificationTypes.includes(value as EmailNotificationType);
}

function isRecipientMode(value: unknown): value is EmailRecipientMode {
  return emailRecipientModes.includes(value as EmailRecipientMode);
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "read");
    const policies = await getEmailNotificationPolicies();
    const outboxStats = await getEmailNotificationOutboxStats();
    const previews = Object.fromEntries(
      emailNotificationTypes.map((type) => [type, buildEmailNotificationPreview(type)]),
    );

    return NextResponse.json({ outboxStats, policies, previews });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to email notification settings." }, { status: 403 });
    }

    const message = error instanceof Error ? error.message : "Email notification settings failed.";
    return NextResponse.json({ error: "email_notifications_failed", message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");
    const body = (await request.json().catch(() => ({}))) as {
      enabled?: unknown;
      includeHrInbox?: unknown;
      notificationType?: unknown;
      recipientMode?: unknown;
    };

    if (!isNotificationType(body.notificationType)) {
      return NextResponse.json({ error: "invalid_type", message: "Unsupported email notification type." }, { status: 400 });
    }

    if (!isRecipientMode(body.recipientMode)) {
      return NextResponse.json({ error: "invalid_mode", message: "Unsupported recipient routing mode." }, { status: 400 });
    }

    const policy = await saveEmailNotificationPolicy(
      body.notificationType,
      {
        enabled: Boolean(body.enabled),
        includeHrInbox: Boolean(body.includeHrInbox),
        recipientMode: body.recipientMode,
      },
      access.hrId,
    );

    return NextResponse.json({ policy });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to update email notification settings." }, { status: 403 });
    }

    const message = error instanceof Error ? error.message : "Email notification settings failed.";
    return NextResponse.json({ error: "email_notifications_failed", message }, { status: 500 });
  }
}
