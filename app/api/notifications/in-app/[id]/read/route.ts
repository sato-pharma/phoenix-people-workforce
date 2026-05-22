import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { markInAppNotificationRead } from "@/lib/notifications/in-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthorized", message: "Authentication is required." }, { status: 401 });
    }

    const { id } = await params;
    const marked = await markInAppNotificationRead(access, id);
    if (!marked) {
      return NextResponse.json({ error: "not_found", message: "Notification was not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to mark notification as read.";
    return NextResponse.json({ error: "notification_read_failed", message }, { status: 500 });
  }
}
