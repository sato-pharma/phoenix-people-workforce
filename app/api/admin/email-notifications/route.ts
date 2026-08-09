import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  emailNotificationTypes,
  emailRecipientModes,
  getEmailNotificationOutboxStats,
  getEmailNotificationPolicies,
  getEmailRoutingOptions,
  saveEmailNotificationPolicy,
  type EmailNotificationType,
  type EmailRecipientMode,
} from "@/lib/notifications/email";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isNotificationType(value: unknown): value is EmailNotificationType {
  return emailNotificationTypes.includes(value as EmailNotificationType);
}

function isRecipientMode(value: unknown): value is EmailRecipientMode {
  return emailRecipientModes.includes(value as EmailRecipientMode);
}

function cleanRecipientModes(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(isRecipientMode)));
}

function cleanTextArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "read");
    const policies = await getEmailNotificationPolicies();
    const outboxStats = await getEmailNotificationOutboxStats();
    const routingOptions = await getEmailRoutingOptions();

    return NextResponse.json({ outboxStats, policies, routingOptions });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to email notification settings." }, { status: 403 });
    }

    const message = clientSafeErrorMessage(error, "Email notification settings failed.");
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
      recipientModes?: unknown;
      targetLines?: unknown;
      targetTitles?: unknown;
    };

    if (!isNotificationType(body.notificationType)) {
      return NextResponse.json({ error: "invalid_type", message: "Unsupported email notification type." }, { status: 400 });
    }

    const recipientModes = cleanRecipientModes(body.recipientModes);
    const fallbackRecipientMode = isRecipientMode(body.recipientMode) ? body.recipientMode : recipientModes[0];

    if (!fallbackRecipientMode) {
      return NextResponse.json({ error: "invalid_mode", message: "Unsupported recipient routing mode." }, { status: 400 });
    }

    // Email WORDING is owned exclusively by /admin/email-templates; this endpoint only
    // governs delivery (on/off, recipient routing, HR-inbox copy). No template content is
    // accepted or returned here.
    const policy = await saveEmailNotificationPolicy(
      body.notificationType,
      {
        enabled: Boolean(body.enabled),
        includeHrInbox: Boolean(body.includeHrInbox),
        recipientMode: fallbackRecipientMode,
        recipientModes: recipientModes.length ? recipientModes : [fallbackRecipientMode],
        targetLines: cleanTextArray(body.targetLines),
        targetTitles: cleanTextArray(body.targetTitles),
      },
      access.hrId,
    );

    return NextResponse.json({ policy });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to update email notification settings." }, { status: 403 });
    }

    const message = clientSafeErrorMessage(error, "Email notification settings failed.");
    return NextResponse.json({ error: "email_notifications_failed", message }, { status: 500 });
  }
}
