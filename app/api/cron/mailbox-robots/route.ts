import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { answerNowThenFinish } from "@/lib/http/answer-now";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { runRobotSweepPass } from "@/lib/mailbox-offboarding/robot/sweep-hook";
import { defaultJoinerSweepDeps } from "@/lib/new-hire-mailbox/robot/sweep-deps";
import { runJoinerSweepPass } from "@/lib/new-hire-mailbox/robot/sweep-hook";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError, logInfo } from "@/lib/observability/log";
import { claimJobLease, newJobLeaseHolderId, type JobLeaseRpcClient } from "@/lib/platform/job-lease";
import { refuseUnlessRobot } from "@/lib/platform/worker-only-route";
import { assertCronAuthorized } from "@/lib/security/cron-auth";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The heartbeat this job reports to. Undeclared until the job is armed — see below. */
const JOB_SLUG = "phoenix-mailbox-robots";
const JOB = "cron/mailbox-robots";
/** One run at a time across every replica, held for at most an hour if a run dies holding it. */
const LEASE_KEY = "mailbox-robots";
const LEASE_TTL_SECONDS = 3600;

/**
 * The two Turbify mailbox robots — the leaver revocation robot and the joiner provisioning robot —
 * on the ROBOT SERVICE, `phoenix-workforce-robot` (audit REC-075).
 *
 * Until the robot service existed they rode the daily mailbox-offboarding sweep on the website, so a
 * Chromium opened beside the pages employees were using. Once PHOENIX_ROBOT_SERVICE_URL is set on the
 * website that sweep skips them, and this route runs them instead, on its own cron-job.org job at
 * 08:20 Cairo — five minutes after the sweep has brought the leavers' register up to date.
 *
 * In this order: the cron bearer; 503 `wrong_process` anywhere but the robot service (so a scheduler
 * pointed at the website or the worker can never open a robot browser there); then a 202 at once,
 * because the scheduler hangs up at 30 seconds and a live robot pass takes minutes. Then a job lease,
 * so a re-fire or a second replica never drives the same mailboxes twice, then the two passes. Each
 * pass is off by default and dry-run by default once enabled, and never throws (sweep-hook.ts).
 *
 * The heartbeat `phoenix-mailbox-robots` is deliberately NOT declared in JOB_SCHEDULES yet: a declared
 * job that has never reported is paged as stranded every 15 minutes, and this one cannot report until
 * the service exists and its cron job is armed. It is declared in the change that arms it.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, JOB);
  if (denied) return denied;
  const wrongProcess = refuseUnlessRobot(JOB);
  if (wrongProcess) return wrongProcess;
  return answerNowThenFinish(request, JOB_SLUG, () => runRobots());
}

async function runRobots(): Promise<Response> {
  const holder = newJobLeaseHolderId();
  const client = () => getSupabaseAdmin() as unknown as JobLeaseRpcClient;
  try {
    const lease = await claimJobLease(client(), { holder, jobKey: LEASE_KEY, ttlSeconds: LEASE_TTL_SECONDS });
    if (!lease.held) {
      // Another run is still driving the mailboxes. Not a failure of this job, so no heartbeat:
      // the run that holds the lease reports.
      logInfo("Mailbox robots skipped — another run holds the lease", {
        labels: { event: "mailbox_robots_lease_held_elsewhere", job: "mailbox-robots" },
      });
      return NextResponse.json({ ran: false, reason: "held_elsewhere", success: true });
    }
    try {
      const robot = await runRobotSweepPass();
      const joiner = await runJoinerSweepPass(defaultJoinerSweepDeps());
      await pingDeadMansSwitch(JOB_SLUG, "success");
      return NextResponse.json({ joiner, ran: true, robot, success: true });
    } finally {
      // Released by re-claiming for one second, so the next run is never held back by an hour-long
      // lease this finished run no longer needs. Best-effort: an unreleased lease simply expires.
      await claimJobLease(client(), { holder, jobKey: LEASE_KEY, ttlSeconds: 1 }).catch(() => undefined);
    }
  } catch (error) {
    await pingDeadMansSwitch(JOB_SLUG, "fail", describeThrown(error));
    logError("Mailbox robots run failed", {
      error,
      labels: { event: "cron_failed", job: "mailbox-robots" },
    });
    const message = clientSafeErrorMessage(error, "The mailbox robots could not be run.");
    return NextResponse.json({ error: "mailbox_robots_failed", message }, { status: 500 });
  }
}
