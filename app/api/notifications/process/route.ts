import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { describeDrainHealth } from "@/lib/notifications/drain-health";
import { runScheduledNotificationProcessing } from "@/lib/notifications/scheduled-processing";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";
import { refuseOnPageServer } from "@/lib/platform/worker-only-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Matches the live scheduler job name — the outbox drain.
const DRAIN_JOB_SLUG = "phoenix-process-notifications";

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
    const message = clientSafeErrorMessage(error, "Notification processing failed.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    return NextResponse.json({ error: "notification_process_failed", message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "notifications/process", {
    message: "Notification processing run is not authorized.",
  });
  if (denied) return denied;
  const wrongProcess = refuseOnPageServer("notifications/process");
  if (wrongProcess) return wrongProcess;
  try {
    // The Vercel cron (every ~30 min, see vercel.json) passes ?limit= so a backlog can
    // drain faster than the once-daily Vercel cron. Vercel auto-attaches the CRON_SECRET
    // bearer (verified by assertCronAuthorized above). Clamp to [1, 50]; default 50.
    const requested = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(50, Math.trunc(requested))) : 50;
    // Deliberately NOT withDeadMansSwitch. That wrapper pings "success" whenever the body
    // resolves, and the body resolved perfectly every 5 minutes from 2026-08-14 to 2026-08-27
    // while the outbox was frozen and delivering nothing — so the monitor stayed green through
    // the entire incident. Ping the QUEUE'S VERDICT instead: a run that completes but strands
    // work that was already due takes the check DOWN. Same pattern, and the same reason, as
    // app/api/notifications/daily/route.ts — a partial failure that must not read as success.
    const processing = await runScheduledNotificationProcessing(limit);

    if (processing.skipped) {
      // An overlapping run is normal operation under load, not a fault, and the run still in
      // flight will ping its own verdict when it finishes.
      await pingDeadMansSwitch(DRAIN_JOB_SLUG, "success", `skipped: ${processing.reason}`);
    } else if (!processing.drainHealth.healthy) {
      await pingDeadMansSwitch(DRAIN_JOB_SLUG, "fail", describeDrainHealth(processing.drainHealth));
    } else {
      await pingDeadMansSwitch(DRAIN_JOB_SLUG, "success");
    }

    // Still HTTP 200: the request itself did not fail, and flipping the cron red would only add
    // noise to a channel nobody watches. The alert is the dead-man's switch above and the
    // `drain_stranded` ERROR log the orchestrator writes.
    return NextResponse.json({ success: true, ...processing });
  } catch (error) {
    await pingDeadMansSwitch(
      DRAIN_JOB_SLUG,
      "fail",
      describeThrown(error),
    );
    console.error(error, { tags: { cron: "notification-outbox-drain" } });
    const message = clientSafeErrorMessage(error, "Notification processing failed.");
    return NextResponse.json({ error: "notification_process_failed", message }, { status: 500 });
  }
}
