import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { logError } from "@/lib/observability/log";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { rotateCvLifecycleSheetToken } from "@/lib/recruitment/cv-lifecycle-sheet-token-rotation";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Healthchecks slug, `phoenix-<route>` like every other watched cron route.
 *
 * WIRED 2026-09-05, in this order and for this reason. Declaring a slug in
 * src/lib/observability/job-schedule.ts (and the matching row in docs/observability.md, which CI
 * asserts agrees with it) tells the heartbeat sweep this job SHOULD be reporting — so declaring it
 * before a scheduler existed would have paged a human in-app and on Telegram, every day, about a
 * job nobody had scheduled. An alarm that is usually wrong is an alarm that gets ignored, and this
 * repo has already paid for that once. So the cron-job.org job was created FIRST — `8387636`,
 * Fridays 04:03 Africa/Cairo, twenty minutes behind the marketing rotation at 03:43 and forty
 * behind direct orders at 03:23, because each waits on a Google Apps Script round-trip this route
 * allows 60s while cron-job.org gives up on the request at 30s, and that spacing is what keeps the
 * three from overlapping — and the declaration followed in the same pull request.
 *
 * The sheet side is live too: the Web App deployment exists, its `WEBHOOK_SECRET` script property
 * is set, and `CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_URL` / `_SECRET` hold the matching pair on
 * Railway production. Proven end to end before this was declared: a POST carrying the wrong secret
 * answered `denied`, one carrying the right secret answered `ok`, and the sheet's own
 * `phoenixCvLastGoodStamp` moved to the minute of that call.
 *
 * The route stays safe to run unconfigured — with the two variables unset it answers 200
 * `{ rotated: false, reason: "not configured" }` and touches nothing — so losing either variable
 * degrades to a no-op rather than an error, and the heartbeat keeps reporting either way. That is
 * why a silent `rotated: false` week is worth reading: see the HTTP contract note below.
 */
const JOB_SLUG = "phoenix-cv-lifecycle-rotate-sheet-token";

/**
 * Rotate the CV-lifecycle live sheet's feed token — the third of three, after direct orders and
 * marketing requests.
 *
 * WHY THIS SHEET NEEDED IT MOST. Its token reads every candidate's NAME and PHONE NUMBER — personal
 * data about people who are not employees and never agreed to be in a spreadsheet — and it is the
 * one sheet whose credential is a bare bearer token with no passcode, because the consumer is a
 * timer-driven script that cannot log in. It shipped (#3102) with no rotation and no UI at all, so
 * its first token was minted by hand in SQL and sat unchanged until a human replaced it by hand.
 *
 * Safe to run on a schedule and safe to run twice. The old token is revoked ONLY after the sheet
 * confirms it has stored and USED the new one, so an unreachable sheet leaves everything working on
 * the old token rather than stranding the owner with a report that can no longer read anything.
 *
 * Returns 200 with `{ rotated: false, reason }` when there is nothing to do — a no-op is a normal
 * outcome here, not a failure, and returning non-200 for it would train whoever schedules this to
 * ignore genuine errors.
 *
 * THE HTTP CONTRACT AND THE SWITCH DELIBERATELY DISAGREE, AND BOTH ARE RIGHT — the same reasoning
 * as both counterparts. Once configured, every path yielding `rotated: false` is something a person
 * has to fix, and a successful rotation always leaves exactly one live link behind, so the steady
 * state is `rotated: true` every week. `withDeadMansSwitch` reads throw/no-throw and so cannot say
 * that; the outcome is derived here.
 *
 * ONE EXCEPTION, and it is why the ping below is not a plain `result.rotated`. Before the owner
 * wires up the Apps Script web app, "not configured" is the CORRECT steady state and pinging /fail
 * for it would make the switch red for a job that is behaving exactly as intended. That one reason
 * pings success; every other falsy outcome is a real problem and pings fail.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/cv-lifecycle-rotate-sheet-token");
  if (denied) return denied;
  try {
    const result = await rotateCvLifecycleSheetToken();
    const unconfigured = !result.rotated && result.reason.includes("is not configured");
    await pingDeadMansSwitch(
      JOB_SLUG,
      result.rotated || unconfigured ? "success" : "fail",
      result.rotated || unconfigured ? undefined : `the token was not rotated: ${(result as { reason: string }).reason}`,
    );
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("CV-lifecycle sheet token rotation failed", {
      error,
      labels: { event: "cv_lifecycle_sheet_rotation_failed" },
    });
    // A throw never reaches the ping above, and that is the case the external monitor exists for:
    // nothing about this run's outcome would otherwise leave the app at all.
    await pingDeadMansSwitch(JOB_SLUG, "fail", describeThrown(error));
    return NextResponse.json({ error: "rotation_failed", success: false }, { status: 500 });
  }
}
