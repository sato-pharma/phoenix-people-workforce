import { NextResponse } from "next/server";

import { answerNowThenFinish } from "@/lib/http/answer-now";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { GAP_NOTICE_JOB_SLUG } from "@/lib/private-calendar/gap-notice-rules";
import { runPrivateCalendarGapNotice } from "@/lib/private-calendar/gap-notice";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The employee's own unexplained-day notice (owner, 2026-10-08): Saturday 08:09 Cairo, one notice per
 * employee for the completed Sat-Thu week, in-app and push, saying that their Private Calendar has a
 * day with nothing recorded on it and that Request review is how to answer it.
 *
 * 🔴 IT JUDGES NOTHING OF ITS OWN. The days come from the same engine call the Deductions module's No
 * Records Activity connector makes, over the same exceptions the employee's own calendar renders, so
 * the day the notice names, the day the calendar shows, and the day that can become a deduction
 * candidate are one
 * day by construction.
 *
 * The audience is the employee alone — never the manager, never HR. A recording gap is not an
 * accusation, and nobody else is told before the employee has had the chance to answer.
 *
 * Safe to fire twice: the idempotency key is per employee per WEEK, so a retry or double fire reaches
 * nobody a second time. A week with no unexplained day sends nothing at all, and the dead-man's switch
 * is what proves it ran.
 *
 * It answers 202 at once and finishes after the response (13 Nov 2026): the scheduler hangs up at 30
 * seconds and this run took 28,987 ms, one slow week from being recorded as a failure. `?wait=1`
 * waits for the report as before. See answer-now.ts.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/private-calendar-gap-notice");
  if (denied) return denied;
  return answerNowThenFinish(request, GAP_NOTICE_JOB_SLUG, () => runGapNotice());
}

async function runGapNotice(): Promise<Response> {
  try {
    const result = await withDeadMansSwitch(GAP_NOTICE_JOB_SLUG, () => runPrivateCalendarGapNotice());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Private Calendar gap notice failed", {
      error,
      labels: { event: "cron_failed", job: "private-calendar-gap-notice" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Private Calendar gap notice failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
