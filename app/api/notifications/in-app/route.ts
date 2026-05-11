import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { listInAppNotificationsForViewer } from "@/lib/notifications/in-app";

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
    const message = error instanceof Error ? error.message : "Unable to load notifications.";
    return NextResponse.json({ error: "notification_load_failed", message }, { status: 500 });
  }
}
