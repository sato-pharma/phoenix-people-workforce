import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { processNotificationOutbox } from "@/lib/notifications/email";
import { processDueProbationReminderEvents } from "@/lib/probation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isCronAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV === "development";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function runNotificationOutbox(limit: number) {
  const probationReminders = await processDueProbationReminderEvents(limit);
  const outbox = await processNotificationOutbox(limit);
  return NextResponse.json({ success: true, outbox, probationReminders });
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "read");

    const body = await request.json().catch(() => ({}));
    const requestedLimit = Number(body?.limit ?? 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(50, Math.trunc(requestedLimit)))
      : 10;

    return await runNotificationOutbox(limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification processing failed.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    return NextResponse.json({ error: "notification_process_failed", message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    if (!isCronAuthorized(request)) {
      return NextResponse.json({ error: "unauthorized", message: "Notification processing run is not authorized." }, { status: 401 });
    }

    return await runNotificationOutbox(10);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification processing failed.";
    return NextResponse.json({ error: "notification_process_failed", message }, { status: 500 });
  }
}
