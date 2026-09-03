import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { writeAuditLog } from "@/lib/admin/audit";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { describeJobHeartbeats } from "@/lib/observability/job-heartbeat-assess";
import { notifyJobsStranded } from "@/lib/observability/job-heartbeat-alert";
import { sweepJobHeartbeats } from "@/lib/observability/job-heartbeat";
import { JOB_HEARTBEAT_SWEEP_SLUG } from "@/lib/observability/job-schedule";
import { logError, logInfo } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The sweeper for the in-house dead-man's switch: reads `public.job_heartbeats`, judges every
 * declared job against its schedule, and pages a human in-app + Telegram when one has stopped
 * reporting or has reported a failure.
 *
 * WHY THIS PINGS SUCCESS EVEN WHEN IT FINDS PROBLEMS.
 * Its own dead-man's switch answers exactly one question — "is the sweeper still running?" — and
 * nothing else. Pinging /fail because some OTHER job is stranded would make the watchdog's own
 * check red for a fault that is not its own, and the first thing anyone would do is stop trusting
 * it. Findings go out through the alert, which is the channel a human actually reads. /fail here
 * means the sweep itself could not complete.
 *
 * THE HOLE THIS DOES NOT CLOSE, stated plainly rather than left to be discovered.
 * A sweeper that stops entirely cannot report its own silence. `phoenix-job-heartbeat-sweep` is a
 * declared job and holds a row like any other, so it verifies itself whenever it runs — but only
 * an EXTERNAL check catches it going quiet, and the Healthchecks free tier was full at 20 when
 * this shipped. Freeing one slot for this slug is the single action that closes it; every other
 * job is now covered internally, which is what finally makes retiring an external check safe.
 * See docs/observability.md.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/job-heartbeat-sweep");
  if (denied) return denied;

  const startedAt = Date.now();

  try {
    const verdict = await sweepJobHeartbeats();
    const summary = describeJobHeartbeats(verdict);

    let alert: Awaited<ReturnType<typeof notifyJobsStranded>> = { delivered: 0, skipped: true };

    if (verdict.healthy) {
      logInfo("Job heartbeat sweep: every watched job reported on time", {
        labels: { event: "job_heartbeat_sweep_healthy", job: JOB_HEARTBEAT_SWEEP_SLUG },
      });
    } else {
      // logError, not logWarning: this is the shape the whole layer exists to surface, and it must
      // be findable in `railway logs` independently of whether the notification went out.
      logError("Job heartbeat sweep found jobs that have stopped reporting", {
        error: new Error(summary),
        labels: { event: "job_heartbeat_stranded", job: JOB_HEARTBEAT_SWEEP_SLUG },
      });
      alert = await notifyJobsStranded(verdict);

      // Only written when something is wrong. A row every 15 minutes saying "all fine" would bury
      // the audit log in 96 entries a day and make the real ones harder to find.
      await writeAuditLog({
        actorLoginId: "job-heartbeat-sweep-cron",
        entityId: JOB_HEARTBEAT_SWEEP_SLUG,
        entityType: "scheduled_job_health",
        newValues: {
          alertDelivered: alert.delivered,
          alertSkippedReason: alert.reason ?? null,
          checked: verdict.checked,
          failing: verdict.failing.map((problem) => problem.slug),
          misdeclared: verdict.misdeclared.map((problem) => problem.slug),
          stranded: verdict.stranded.map((problem) => problem.slug),
        },
        summary,
      });
    }

    // Success = the sweep completed. See the header note on why findings do not turn this red.
    await pingDeadMansSwitch(
      JOB_HEARTBEAT_SWEEP_SLUG,
      "success",
      `${verdict.checked} job(s) checked, ${verdict.stranded.length} stranded, ${verdict.failing.length} failing`,
    );

    return NextResponse.json(
      {
        alertDelivered: alert.delivered,
        awaitingBootstrap: verdict.awaitingBootstrap,
        checked: verdict.checked,
        durationMs: Date.now() - startedAt,
        failing: verdict.failing,
        healthy: verdict.healthy,
        misdeclared: verdict.misdeclared,
        stranded: verdict.stranded,
        summary,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    logError("Job heartbeat sweep failed", {
      error,
      labels: { event: "cron_failed", job: JOB_HEARTBEAT_SWEEP_SLUG },
    });
    await pingDeadMansSwitch(
      JOB_HEARTBEAT_SWEEP_SLUG,
      "fail",
      describeThrown(error),
    );
    return NextResponse.json(
      { error: "job_heartbeat_sweep_failed", message: clientSafeErrorMessage(error, "The job heartbeat sweep failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
