import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { dispatchSyntheticJourneys } from "@/lib/observability/dispatch-synthetic-journeys";
import { logError } from "@/lib/observability/log";
import { SYNTHETIC_DISPATCH_FAILURE_PREFIX } from "@/lib/observability/synthetic-dispatch-reasons";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Healthchecks slug, `phoenix-<route>` like every other watched cron route.
 *
 * Measured cadence before this was wired (so the check could be tuned instead of guessed): 177
 * `workflow_dispatch` events on synthetic-journeys.yml between 2026-08-15 and 2026-08-23, every one
 * of them landing 4-12 seconds past the top of the hour, every UTC hour of the day represented, one
 * single missed hour in eight days. Railway's HTTP log names the caller: cron-job.org, GET, 200.
 * That is `0 * * * *`; docs/observability.md carries the row and tests/synthetic-journeys-liveness
 * .test.ts keeps the two from drifting apart.
 */
const JOB_SLUG = "phoenix-run-synthetic-journeys";

/**
 * Run the production synthetic journeys now, on a schedule that actually fires.
 *
 * The Synthetic Journeys workflow declares its own `schedule:`, but GitHub does not honour it in
 * this repository. Measured 2026-08-05: both workflows added that day have never fired once, and
 * the only scheduled workflow that does fire (migration-drift-check, added 2026-07-20) lands 4.5-9h
 * after its nominal 07:00 — never on time in six days. cron-job.org, which already drives every
 * other /api/cron/* route, fires on time.
 *
 * So the trigger comes from there and lands here, and this route asks GitHub to start the run. The
 * GitHub token stays in Railway: pointing cron-job.org straight at GitHub's dispatch endpoint would
 * mean putting a write credential into a free-tier third-party account that AGENTS.md already
 * describes as a single point of failure. This way that account gains no GitHub access at all — it
 * presents the same CRON_SECRET it already holds.
 *
 * Returns promptly and does NOT wait for the run to finish. A synthetic run takes ~60s; waiting
 * would risk the false `Failed (timeout)` that cron-job.org's 30s cap logged against the old
 * daily notification run every morning. The run's own result is reported by the workflow.
 *
 * Returns 200 with `{ dispatched: false, reason }` when the token is unset — an unconfigured
 * deployment is a normal outcome, not a failure.
 *
 * WHY THE SWITCH IS PINGED DIRECTLY, NOT VIA withDeadMansSwitch.
 * The wrapper is for routes whose throw/no-throw shape already means what it says. This one's does
 * not, deliberately: a refused, unreachable or unset dispatch answers HTTP 200 with
 * `{ dispatched: false }` so cron-job.org is never trained to read a normal state as an outage —
 * and the wrapper would forward exactly that as a success ping. GITHUB_ACTIONS_DISPATCH_TOKEN is a
 * fine-grained PAT, so it WILL expire. The hour it does, every dispatch 401s, the synthetic suite
 * stops running, `logError` writes a row nothing pages anyone about, and a wrapper-shaped ping
 * would hold the check green while the system's only "is production actually working?" signal is
 * dead. That is the nine-nights-of-401 failure one layer up. So the outcome is derived from the
 * dispatch's own answer, the same way the morning jobs' route (cron/daily/[job]) derives its ping from
 * its job's failures — a single ping per run, carrying the truth.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/run-synthetic-journeys");
  if (denied) return denied;
  try {
    const result = await dispatchSyntheticJourneys();

    await pingDeadMansSwitch(
      JOB_SLUG,
      result.dispatched ? "success" : "fail",
      result.dispatched ? undefined : `${SYNTHETIC_DISPATCH_FAILURE_PREFIX}${result.reason}`,
    );

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Synthetic journeys dispatch failed", {
      labels: { event: "synthetic_dispatch_failed" },
      error,
    });
    // A crash never reaches the ping above, and this is the single most important case for the
    // external monitor to catch — nothing about this run's outcome would otherwise leave the app.
    await pingDeadMansSwitch(
      JOB_SLUG,
      "fail",
      describeThrown(error),
    );
    return NextResponse.json({ success: false, error: "dispatch_failed" }, { status: 500 });
  }
}
