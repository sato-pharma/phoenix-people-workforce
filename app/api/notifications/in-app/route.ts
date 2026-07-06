import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  archiveAllInAppNotifications,
  listInAppNotificationsForViewer,
  markAllInAppNotificationsRead,
  markInAppNotificationRead,
} from "@/lib/notifications/in-app";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ data: [], success: true });
    }

    const notifications = await listInAppNotificationsForViewer(access);
    return NextResponse.json({ data: notifications, success: true });
  } catch (error) {
    console.error("GET /api/notifications/in-app failed", error);
    const message = error instanceof Error ? error.message : "Unable to load notifications.";
    return NextResponse.json({ error: "notification_load_failed", message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    if (body.markAll === true) {
      return NextResponse.json({ data: await markAllInAppNotificationsRead(access), success: true });
    }
    if (body.clearAll === true) {
      return NextResponse.json({ data: await archiveAllInAppNotifications(access), success: true });
    }

    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return NextResponse.json({ error: "missing_notification_id" }, { status: 400 });
    return NextResponse.json({ data: await markInAppNotificationRead(access, id), success: true });
  } catch (error) {
    console.error("PATCH /api/notifications/in-app failed", error);
    const message = error instanceof Error ? error.message : "Unable to update notification.";
    return NextResponse.json({ error: "notification_update_failed", message }, { status: 500 });
  }
}
