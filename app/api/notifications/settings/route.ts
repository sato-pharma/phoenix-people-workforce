import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getNotificationSettings, saveNotificationPreferences } from "@/lib/notifications/settings";
import { shouldShowTelegramHomeCard } from "@/lib/notifications/telegram-home-card-rules";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    const data = await getNotificationSettings(access);
    // The home page's Telegram card is decided HERE, because only the server knows a test account (owner,
    // 13 Nov 2026: "Every home page, once"). The card draws what this says.
    const homeCards = {
      telegram: shouldShowTelegramHomeCard({
        isTestAccount: Boolean(access.testPersona),
        modulePreferences: data.preferences.modulePreferences,
        telegramStatus: data.telegram.status,
      }),
    };
    return NextResponse.json({ data, homeCards, success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = clientSafeErrorMessage(error, "Unable to load notification settings.");
    return NextResponse.json({ error: "notification_settings_load_failed", message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "update");
    const body = await request.json().catch(() => ({}));
    const data = await saveNotificationPreferences(access, {
      emailEnabled: body.emailEnabled,
      inAppEnabled: body.inAppEnabled,
      preferredChannel: body.preferredChannel,
      pushEnabled: body.pushEnabled,
      quietHoursEnd: body.quietHoursEnd,
      quietHoursStart: body.quietHoursStart,
      telegramEnabled: body.telegramEnabled,
    });
    return NextResponse.json({ data, success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = clientSafeErrorMessage(error, "Unable to save notification settings.");
    return NextResponse.json({ error: "notification_settings_save_failed", message }, { status: 500 });
  }
}
