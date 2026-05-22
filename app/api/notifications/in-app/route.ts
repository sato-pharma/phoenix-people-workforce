import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { listInAppNotificationsForViewer } from "@/lib/notifications/in-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ data: [], readCount: 0, success: true, unreadCount: 0 });
    }

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 8);
    const notifications = await listInAppNotificationsForViewer(access, Number.isFinite(limit) ? limit : 8);
    return NextResponse.json({
      data: notifications,
      readCount: notifications.filter((notification) => notification.isRead).length,
      success: true,
      unreadCount: notifications.filter((notification) => !notification.isRead).length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load notifications.";
    return NextResponse.json({ error: "notification_load_failed", message }, { status: 500 });
  }
}
