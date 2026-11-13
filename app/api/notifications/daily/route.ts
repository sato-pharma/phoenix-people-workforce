import { NextResponse } from "next/server";

import { createDailyJobFailureCollector, DAILY_JOB_RUNNERS } from "@/app/api/cron/daily/_lib/daily-job-runners";
import { answerNowThenFinish } from "@/lib/http/answer-now";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { pingDeadMansSwitch, signalDeadMansSwitchStart } from "@/lib/observability/dead-mans-switch";
import { logError, logInfo } from "@/lib/observability/log";
import {
  DAILY_JOBS,
  dailyJobCairoTime,
  dailyJobPath,
  dailyJobsRunOn,
  dailyJobsSplitIsOn,
} from "@/lib/scheduled-jobs/daily-jobs";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * THE 06:36 MORNING FAN-OUT — and, once the split is switched on, the authorised no-op it becomes.
 *
 * The owner chose that each morning job gets its own schedule (13 Nov 2026, enterprise audit F-HR-012 /
 * REC-049): each runs on its own address, `/api/cron/daily/<job>`, its own cron-job.org entry and
 * minute, and its own heartbeat. Arming thirty cron-job.org entries costs about 120 API requests and
 * the account allows 100 a day, so the switch-over is a SWITCH, `PHOENIX_DAILY_JOBS_SPLIT`, read in
 * one place (src/lib/scheduled-jobs/daily-jobs.ts):
 *
 *   - OFF (unset, and what ships): this route runs ALL thirty jobs exactly as it always has — the
 *     Needs You digest awaited alone first, then the other twenty-nine at once, in the same order,
 *     each through the same call (app/api/cron/daily/_lib/daily-job-runners.ts), the same answer
 *     keys, the same run summary, and the `phoenix-notify-daily` start signal and ping.
 *   - ON: this route runs NOTHING and answers 200, because two schedulers this repository does not
 *     manage still call it — cron-job.org job `8200909` (06:36 Cairo, made by hand) and the
 *     `phoenix-cron` fallback service in .railway/railway.ts — and an error would put a red on every
 *     morning for work that now happens elsewhere.
 *
 * 🔴 NEVER LET IT RUN A JOB WHILE THE SWITCH IS ON: every job then also runs from its own schedule, so
 * it would run twice a morning. `dailyJobsRunOn` gives this route and the per-job route the same
 * answer, and `tests/daily-jobs-split.test.ts` holds both to it. Runbook: docs/deployment.md,
 * "Switching the morning jobs over". Once the switch has been on for good, a later change retires the
 * two callers above, the switch, and the fan-out below.
 */
async function runDailyNotifications(request: Request) {
  // Truthful reporting (owner report 2026-07-25: "it says success even when it's broken"). Each job
  // keeps its own .catch() and fallback so one failure can never abort the others; every failure goes
  // through logError with the standard {event: "cron_failed", job} labels and is collected so the
  // response can say plainly which jobs failed.
  //
  // Deliberately still HTTP 200 on a partial failure: a scheduler that retries a 5xx would re-run
  // every job, risking the duplicate-email incident this reporting exists to prevent. The run-summary
  // log and the ping below are what alerting keys on.
  const { failures, onJobFailure } = createDailyJobFailureCollector();

  // 🔴 THE NEEDS YOU BOARD RUNS ON ITS OWN, BEFORE THE FAN-OUT. It is 22 sources behind its own
  // two-lane scheduler; as a passenger in the fan-out it lost 1-5 sources every morning for 15
  // mornings running from 2026-10-09. DO NOT MOVE IT BACK INTO THE Promise.all, and do not "fix" a
  // returning amber row by widening a lane or raising the 8-second budget (daily-job-runners.ts).
  const digest = DAILY_JOBS[0];
  const results = new Map<string, unknown>();
  results.set(digest.key, await DAILY_JOB_RUNNERS[digest.key].run(request, onJobFailure));

  // The other twenty-nine, started together in the list's order — the order the fan-out has always
  // started them in. Each carries its own `.catch`, so none can stop the rest.
  const rest = DAILY_JOBS.slice(1);
  const settled = await Promise.all(rest.map((job) => DAILY_JOB_RUNNERS[job.key].run(request, onJobFailure)));
  rest.forEach((job, index) => results.set(job.key, settled[index]));

  // Birthdays, contract renewals and holiday confirmation answer with a Response; read their bodies.
  const answer: Record<string, unknown> = {};
  for (const job of DAILY_JOBS) {
    const raw = results.get(job.key);
    answer[DAILY_JOB_RUNNERS[job.key].resultName] = raw instanceof Response ? await raw.json() : raw;
  }

  // One structured line per run that states the real outcome. This — not the HTTP status, and not the
  // dead-man's-switch ping — is the signal to alert on:
  // `event="cron_run_summary" job="notifications/daily" failedCount>0`. Counted from the list, so it
  // can no longer drift from the jobs actually run.
  const totalJobs = DAILY_JOBS.length;
  if (failures.length > 0) {
    logError(
      `Daily notification run completed with ${failures.length} of ${totalJobs} sub-job(s) FAILED: ${failures.map((f) => f.job).join(", ")}`,
      {
        context: { failures },
        labels: {
          event: "cron_run_summary",
          failedCount: failures.length,
          job: "notifications/daily",
          outcome: "partial_failure",
          totalJobs,
        },
      },
    );
  } else {
    logInfo(`Daily notification run completed — all ${totalJobs} sub-jobs succeeded`, {
      labels: { event: "cron_run_summary", failedCount: 0, job: "notifications/daily", outcome: "success", totalJobs },
    });
  }

  // The slug is the dead man's switch's IDENTITY at Healthchecks; renaming it would orphan the check
  // and its history. A PARTIAL failure — which never throws, by design — still pings /fail. While the
  // switch is off the per-job slugs are NOT pinged: see dailyJobSchedulesFor in job-schedule.ts.
  await pingDeadMansSwitch(
    "phoenix-notify-daily",
    failures.length > 0 ? "fail" : "success",
    failures.length > 0 ? `${failures.length}/${totalJobs} sub-job(s) failed: ${failures.map((f) => f.job).join(", ")}` : undefined,
  );

  return NextResponse.json({
    ...answer,
    failedCount: failures.length,
    failedJobs: failures,
    // Truthful: false when ANY sub-job failed.
    success: failures.length === 0,
    totalJobs,
  });
}

/** Switch ON: the jobs run from their own schedules; this answers and runs nothing. */
function answerSplitIsOn() {
  // Logged so the two stale callers above can be found and switched off: their fires land here.
  logInfo("The retired daily fan-out was called; it ran nothing (each morning job has its own schedule now)", {
    labels: { event: "retired_route_called", job: "notifications/daily" },
  });

  return NextResponse.json({
    jobs: DAILY_JOBS.map((job) => ({ cairoTime: dailyJobCairoTime(job), job: job.key, name: job.name, path: dailyJobPath(job.key) })),
    message:
      "Nothing was run. The morning jobs are switched over: each runs on its own schedule at /api/cron/daily/<job>, " +
      "with its own heartbeat; this address only answers so its old scheduler does not record a failure.",
    ran: 0,
    retired: true,
  });
}

export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "notifications/daily", {
    message: "Daily notification run is not authorized.",
  });
  if (denied) return denied;
  if (dailyJobsRunOn(dailyJobsSplitIsOn()) !== "fan-out") return answerSplitIsOn();
  // The scheduler hangs up at 30 seconds and this run takes longer (cut at 30,141 ms on 13 Nov 2026),
  // so it is answered 202 at once and finished after the response; `?wait=1` waits for the report as
  // before. The verdict is the ping, never this route's status. See answer-now.ts.
  return answerNowThenFinish(request, "phoenix-notify-daily", async () => {
    // The start signal comes BEFORE the run so a container swap that kills it mid-way (06:37 on
    // 2026-10-16) reads "started, never finished" at Healthchecks instead of an unexplained silence.
    // Every path out of runDailyNotifications ends in a success or fail ping, so a start is never orphaned.
    await signalDeadMansSwitchStart("phoenix-notify-daily");
    try {
      return await runDailyNotifications(request);
    } catch (error) {
      logError("Daily notification dispatcher failed", { labels: { event: "cron_failed", job: "notifications/daily" }, error });
      // A total dispatcher crash never reaches the per-run ping inside runDailyNotifications, so it
      // needs its own. The external monitor gets the same redacted text as the response.
      const message = clientSafeErrorMessage(error, "Daily notification run failed.");
      await pingDeadMansSwitch("phoenix-notify-daily", "fail", message);
      return NextResponse.json({ error: "daily_notifications_failed", message }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  return GET(request);
}
