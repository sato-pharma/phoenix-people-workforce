import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { runScheduledNotificationProcessing } from "@/lib/notifications/scheduled-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isCronAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Every Vercel environment (production, preview, `vercel dev`) sets VERCEL — only a
  // real local machine without it may bypass an unset CRON_SECRET during development.
  if (!secret) return !process.env.VERCEL && process.env.NODE_ENV === "development";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function runNotificationOutbox(limit: number) {
  const processing = await runScheduledNotificationProcessing(limit);
  return NextResponse.json({ success: true, ...processing });
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");

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
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Notification processing run is not authorized." }, { status: 401 });
  }
  try {
    // The Vercel cron (every ~30 min, see vercel.json) passes ?limit= so a backlog can
    // drain faster than the once-daily Vercel cron. Vercel auto-attaches the CRON_SECRET
    // bearer (verified by isCronAuthorized above). Clamp to [1, 50]; default 50.
    const requested = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(50, Math.trunc(requested))) : 50;
    return await runNotificationOutbox(limit);
  } catch (error) {
    console.error(error, { tags: { cron: "notification-outbox-drain" } });
    const message = error instanceof Error ? error.message : "Notification processing failed.";
    return NextResponse.json({ error: "notification_process_failed", message }, { status: 500 });
  }
}
