import { NextResponse } from "next/server";

import { createDailyJobFailureCollector, DAILY_JOB_RUNNERS } from "@/app/api/cron/daily/_lib/daily-job-runners";
import { answerNowThenFinish } from "@/lib/http/answer-now";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { pingDeadMansSwitch, signalDeadMansSwitchStart } from "@/lib/observability/dead-mans-switch";
import { logError, logInfo } from "@/lib/observability/log";
import {
  DAILY_JOBS,
  dailyJobHeartbeatSlug,
  dailyJobsRunOn,
  dailyJobsSplitIsOn,
  findDailyJob,
} from "@/lib/scheduled-jobs/daily-jobs";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * ONE morning job per request (owner, 13 Nov 2026 — enterprise audit F-HR-012 / REC-049).
 *
 * `/api/cron/daily/<job>` runs exactly the job its last segment names, and nothing else. Each job has
 * its own cron-job.org entry (scripts/cronjob-sync.mjs), its own minute between 06:36 and 07:32 Cairo,
 * and its own heartbeat (`phoenix-daily-<job>`). The list, the order and the times are
 * src/lib/scheduled-jobs/daily-jobs.ts; what each job calls is app/api/cron/daily/_lib/daily-job-runners.ts
 * — the same call the fan-out at /api/notifications/daily makes, word for word.
 *
 * 🔴 IT RUNS NOTHING UNTIL `PHOENIX_DAILY_JOBS_SPLIT` IS `on` (owner, 13 Nov 2026: a safe switch-over).
 * Arming thirty cron-job.org entries takes two days under the account's 100-requests-a-day cap, and
 * until the switch is on the 06:36 fan-out still runs every job. So with the switch off this route
 * authenticates, then answers 200 `{ ran: false, reason: "split_not_switched_on" }`: it runs no job
 * and records NO heartbeat (an early fire is not a run, and a heartbeat here would teach the sweep a
 * job ran when it did not). `dailyJobsRunOn` gives both routes the same answer, so a job runs from
 * one place, never both. Runbook: docs/deployment.md, "Switching the morning jobs over".
 *
 * 🔴 NEVER LOOP OVER THE JOBS HERE, AND NEVER LET ONE REQUEST RUN TWO. Running them together is the
 * defect this route replaced: one heartbeat for thirty jobs, a deploy that killed all of them at once,
 * and jobs queueing behind each other for the database. A person who wants several runs them one
 * request at a time. `tests/daily-jobs-split.test.ts` holds this file to one lookup and no fan-out.
 *
 * Authorised exactly as the fan-out was (the shared cron secret). It answers the scheduler 202 at once
 * and finishes after the response, like the fan-out did, because cron-job.org hangs up at 30 seconds
 * (answer-now.ts); `?wait=1` waits and returns the job's own report. The verdict is the heartbeat:
 * every path out of the run pings success or fail, and the start signal goes first so a run a deploy
 * killed reads "started, never finished" rather than an unexplained silence.
 */

type RouteContext = { params: Promise<{ job: string }> };

async function runOneDailyJob(request: Request, key: keyof typeof DAILY_JOB_RUNNERS, slug: string): Promise<Response> {
  const runner = DAILY_JOB_RUNNERS[key];
  // The fan-out's failure handler, shared word for word (daily-job-runners.ts).
  const { failures, onJobFailure } = createDailyJobFailureCollector();

  const raw = await runner.run(request, onJobFailure);
  const result = raw instanceof Response ? await raw.json() : raw;

  logInfo(`Daily job ${key} finished: ${failures.length > 0 ? "FAILED" : "succeeded"}`, {
    labels: {
      event: "cron_run_summary",
      failedCount: failures.length,
      job: `cron/daily/${key}`,
      outcome: failures.length > 0 ? "failure" : "success",
    },
  });

  await pingDeadMansSwitch(
    slug,
    failures.length > 0 ? "fail" : "success",
    failures.length > 0 ? failures.map((failure) => `${failure.job}: ${failure.message}`).join("; ") : undefined,
  );

  return NextResponse.json(
    {
      [runner.resultName]: result,
      failedJobs: failures,
      job: key,
      success: failures.length === 0,
    },
    { status: failures.length > 0 ? 500 : 200 },
  );
}

export async function GET(request: Request, { params }: RouteContext) {
  const { job } = await params;
  const daily = findDailyJob(job);
  const denied = assertCronAuthorized(request, daily ? `cron/daily/${daily.key}` : "cron/daily", {
    message: "Daily job run is not authorized.",
  });
  if (denied) return denied;
  if (!daily) {
    return NextResponse.json(
      {
        error: "unknown_daily_job",
        jobs: DAILY_JOBS.map((known) => known.key),
        message: "No morning job has that name. Each job runs on its own address, /api/cron/daily/<job>.",
      },
      { status: 404 },
    );
  }

  // Switch off: the 06:36 fan-out runs this job today. Answer, run nothing, record no heartbeat.
  if (dailyJobsRunOn(dailyJobsSplitIsOn()) !== "own-route") {
    return NextResponse.json({
      job: daily.key,
      message:
        "Nothing was run. The morning jobs still run together from /api/notifications/daily until " +
        "PHOENIX_DAILY_JOBS_SPLIT is switched on; this schedule is armed and waiting for that switch.",
      ran: false,
      reason: "split_not_switched_on",
    });
  }

  const slug = dailyJobHeartbeatSlug(daily.key);
  return answerNowThenFinish(request, slug, async () => {
    await signalDeadMansSwitchStart(slug);
    try {
      return await runOneDailyJob(request, daily.key, slug);
    } catch (error) {
      // Every job carries its own `.catch`, so this is a throw none of them expected (reading the
      // job's answer, the ping itself). It still has to reach the heartbeat, or a crash reads as
      // silence until the sweep's grace runs out.
      logError(`Daily job dispatcher failed: ${daily.key}`, {
        labels: { event: "cron_failed", job: `cron/daily/${daily.key}` },
        error,
      });
      const message = clientSafeErrorMessage(error, `Daily job ${daily.key} failed.`);
      await pingDeadMansSwitch(slug, "fail", message);
      return NextResponse.json({ error: "daily_job_failed", job: daily.key, message }, { status: 500 });
    }
  });
}

export async function POST(request: Request, context: RouteContext) {
  return GET(request, context);
}
