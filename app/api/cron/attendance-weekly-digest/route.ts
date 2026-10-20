import { NextResponse } from "next/server";

import { currentCairoDateParts } from "@/lib/i18n/format";
import { applyDigestAnswersForMonth } from "@/lib/attendance/digest-bridge.ts";
import { getDigestSettings, settleOverdueAnswers, syncOpenReviewWeeks } from "@/lib/attendance/digest-service.ts";
import { previousMonthKey } from "@/lib/attendance/digest-weeks.ts";
import { runHrOpsReportsSchedule, type HrOpsScheduleResult } from "@/lib/hr-ops-reports/schedule";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The weekly attendance review's scheduled work, in three steps.
 *
 *   1. SYNC — bring every started week of the review month up to date from the fingerprint
 *      report, through yesterday (owner, 2026-09-17 — "Show live, release any time"): new
 *      flagged days are added unticked, waiting days follow the report, and a waiting day the
 *      report has since cleared is taken off. This step SENDS NOTHING: a day reaches its
 *      employee only when the Super Admin releases it from the admin review page (owner,
 *      2026-09-15). It runs twice a day, because punches arrive late morning.
 *   2. DEADLINE — settle every day still unanswered after its answer deadline (2 working
 *      days from release; days on leave, approved or still waiting for approval, do not
 *      count, so leave filed since the release moves it later) to salary. Owner decisions
 *      2026-09-15 and 2026-09-16.
 *   3. APPLY — take the settled answers and put them on the month-end deduction
 *      candidates, once those candidates exist.
 *
 * Step 2 runs BEFORE step 3 so a day settled to salary this morning reaches its candidate
 * in the same run rather than a day later.
 *
 * WHY STEP 2 LIVES HERE. Without it the module records answers that reach nothing:
 * an employee could confirm a day and the confirmation would sit in the settlement
 * ledger permanently. It ran that way from the rebuild until 2026-09-08 — the bridge
 * was written and never called, which is the "green, deployed and reachable by
 * nobody" shape this repo has been bitten by before.
 *
 * TWO MONTHS, not one. A settlement is written the week the employee answers, but the
 * candidate it belongs to is not created until that month has CLOSED (the deductions
 * collector refuses an in-progress month). So on any given day the answers waiting to
 * be applied span the current month and the one before it, and asking for only the
 * current month would strand every answer given about the previous one.
 *
 * Safe to call any number of times. The sync changes nothing a second time and never touches
 * a released day; the bridge no-ops
 * three ways — a settlement already applied, a candidate a person has already decided,
 * and a day with no candidate yet — so the six extra calls a week do nothing at all.
 *
 * `enabled` is checked first and reported honestly: a disabled module returns
 * `skipped: "disabled"` rather than a cheerful zero, because "0 days added" and
 * "switched off" are indistinguishable otherwise — which is exactly how the outbox
 * drain ran perfectly and did nothing for 13 days.
 *
 * THE HR DAILY & WEEKLY REPORTS RIDE ON THIS RUN (2026-10-20) — src/lib/hr-ops-reports/schedule.ts
 * builds yesterday's report (and last week's on a Sunday), then retries every decided day still
 * waiting to reach this review. It runs AFTER the sync, so a day the sync has just added is there
 * for the retry to set, and it runs even when this review is switched off, because the reports are
 * the HR Operations Specialist's own work. It is fenced in its own try/catch and NEVER fails this
 * run: its failures are logged and returned as `hrOpsReports`, and the digest steps go on.
 */
async function runHrOpsReportsStep(todayIso: string): Promise<{ result: HrOpsScheduleResult | null; error: string | null }> {
  try {
    const result = await runHrOpsReportsSchedule({ todayIso });
    if (result.failures.length) {
      logError("HR Daily & Weekly Reports run had failures", {
        labels: { event: "cron_partial", job: "attendance-weekly-digest", step: "hr-ops-reports", failures: String(result.failures.length) },
      });
    }
    return { error: null, result };
  } catch (error) {
    logError("HR Daily & Weekly Reports run failed", {
      labels: { event: "cron_partial", job: "attendance-weekly-digest", step: "hr-ops-reports" },
      error,
    });
    return { error: clientSafeErrorMessage(error, "The HR Daily & Weekly Reports run failed."), result: null };
  }
}

export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/attendance-weekly-digest");
  if (denied) return denied;

  try {
    // Cairo, never UTC: for the first two or three hours of a Cairo day the UTC date
    // is still yesterday, which would judge a week as closed a day late — or, at the
    // cycle boundary, put a digest in the wrong month entirely.
    const { year, month, day } = currentCairoDateParts();
    const todayIso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    const settings = await getDigestSettings();
    if (!settings.enabled) {
      const hrOpsReports = await runHrOpsReportsStep(todayIso);
      return NextResponse.json({ success: true, skipped: "disabled", dryRun: settings.dryRun, hrOpsReports });
    }

    // A week that fails to sync does not stop the other weeks or the steps below; its failure is
    // returned and turns the run red.
    const synced = await syncOpenReviewWeeks({
      todayIso,
      createdBy: "system:attendance-weekly-digest-cron",
    });
    if (synced.failures.length) {
      logError("Weekly attendance review sync failed for some employees", {
        labels: { event: "cron_partial", job: "attendance-weekly-digest", syncFailures: String(synced.failures.length) },
      });
    }

    // After the sync, before the deadline sweep — see runHrOpsReportsStep. Never fails this run.
    const hrOpsReports = await runHrOpsReportsStep(todayIso);

    // The sync has already committed by this point, so a failure below must not be
    // reported as though the whole run failed — but it must not be swallowed either.
    // Every result is returned, and the status goes 500 so a broken step is loud
    // rather than a quiet zero that reads exactly like "nothing to do".
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;
    const applied: Awaited<ReturnType<typeof applyDigestAnswersForMonth>>[] = [];
    let deadline: Awaited<ReturnType<typeof settleOverdueAnswers>> | null = null;
    let deadlineError: string | null = null;
    try {
      deadline = await settleOverdueAnswers({ todayIso, actor: "system:attendance-weekly-digest-cron" });
    } catch (error) {
      deadlineError = clientSafeErrorMessage(error, "Settling overdue answers failed.");
      logError("Weekly attendance deadline sweep failed", {
        labels: { event: "cron_partial", job: "attendance-weekly-digest" },
        error,
      });
    }

    let bridgeError: string | null = null;
    try {
      // Three months, not two: a dispute on a day late in one month can be decided well into the
      // month after next, and its answer must still reach a deduction that is not locked yet.
      const previous = previousMonthKey(monthKey);
      for (const key of [previousMonthKey(previous), previous, monthKey]) {
        applied.push(await applyDigestAnswersForMonth(key));
      }
    } catch (error) {
      bridgeError = clientSafeErrorMessage(error, "Applying digest answers failed.");
      logError("Weekly attendance digest bridge failed", {
        labels: { event: "cron_partial", job: "attendance-weekly-digest" },
        error,
      });
    }

    // Also loud: a day the sweep could not settle, and a day paid from annual balance that payroll
    // had already approved (taken twice). Each is retried or needs a person, and a 200 would hide it.
    const deadlineFailures = deadline?.failures ?? 0;
    const balanceAlerts = applied.flatMap((result) => result.alerts);
    const syncFailures = synced.failures.length;
    const failed = Boolean(bridgeError || deadlineError || deadlineFailures > 0 || balanceAlerts.length > 0 || syncFailures > 0);
    if (deadlineFailures > 0 || balanceAlerts.length > 0) {
      logError("Weekly attendance run needs attention", {
        labels: { event: "cron_partial", job: "attendance-weekly-digest", deadlineFailures: String(deadlineFailures), balanceAlerts: String(balanceAlerts.length) },
      });
    }
    return NextResponse.json(
      // `notified: 0` stays literal: this job never notifies — the release does.
      { success: !failed, dryRun: settings.dryRun, todayIso, synced, deadline, deadlineError, applied, bridgeError, hrOpsReports, notified: 0 },
      { status: failed ? 500 : 200 },
    );
  } catch (error) {
    logError("Weekly attendance digest cron failed", {
      labels: { event: "cron_failed", job: "attendance-weekly-digest" },
      error,
    });
    return NextResponse.json(
      {
        error: "attendance_weekly_digest_failed",
        message: clientSafeErrorMessage(error, "Weekly attendance digest run failed."),
      },
      { status: 500 },
    );
  }
}
