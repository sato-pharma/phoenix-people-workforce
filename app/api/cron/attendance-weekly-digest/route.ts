import { NextResponse } from "next/server";

import { currentCairoDateParts } from "@/lib/i18n/format";
import { applyDigestAnswersForMonth } from "@/lib/attendance/digest-bridge.ts";
import { generateDigestsForCompletedWeek, getDigestSettings } from "@/lib/attendance/digest-service.ts";
import { previousMonthKey } from "@/lib/attendance/digest-weeks.ts";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The weekly digest's scheduled work, in two steps.
 *
 *   1. GENERATE — build the digests for the settlement week that has just CLOSED,
 *      open for answers immediately.
 *   2. APPLY — take the answers employees have already given and put them on the
 *      month-end deduction candidates, once those candidates exist.
 *
 * There is nothing to send and nothing to sweep. The module notifies nobody (owner,
 * 2026-09-08), and with no notice there is no response window to expire — so the two
 * steps this route used to carry, `send` and `auto-confirm`, are gone rather than
 * disabled. An unanswered day writes no settlement, never reaches step 2, and travels
 * to the month-end Deductions queue as Pending.
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
 * Safe to call daily. Generation skips a week it has already built; the bridge no-ops
 * three ways — a settlement already applied, a candidate a person has already decided,
 * and a day with no candidate yet — so the six extra calls a week do nothing at all.
 *
 * `enabled` is checked first and reported honestly: a disabled module returns
 * `skipped: "disabled"` rather than a cheerful zero, because "0 generated" and
 * "switched off" are indistinguishable otherwise — which is exactly how the outbox
 * drain ran perfectly and did nothing for 13 days.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/attendance-weekly-digest");
  if (denied) return denied;

  try {
    const settings = await getDigestSettings();
    if (!settings.enabled) {
      return NextResponse.json({ success: true, skipped: "disabled", dryRun: settings.dryRun });
    }

    // Cairo, never UTC: for the first two or three hours of a Cairo day the UTC date
    // is still yesterday, which would judge a week as closed a day late — or, at the
    // cycle boundary, put a digest in the wrong month entirely.
    const { year, month, day } = currentCairoDateParts();
    const todayIso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    const generated = await generateDigestsForCompletedWeek({
      todayIso,
      createdBy: "system:attendance-weekly-digest-cron",
    });

    // Generation has already committed by this point, so a failure below must not be
    // reported as though the whole run failed — but it must not be swallowed either.
    // Both results are returned, and the status goes 500 so a broken bridge is loud
    // rather than a quiet "applied: 0" that reads exactly like "nothing to apply".
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;
    const applied: Awaited<ReturnType<typeof applyDigestAnswersForMonth>>[] = [];
    let bridgeError: string | null = null;
    try {
      for (const key of [previousMonthKey(monthKey), monthKey]) {
        applied.push(await applyDigestAnswersForMonth(key));
      }
    } catch (error) {
      bridgeError = clientSafeErrorMessage(error, "Applying digest answers failed.");
      logError("Weekly attendance digest bridge failed", {
        labels: { event: "cron_partial", job: "attendance-weekly-digest" },
        error,
      });
    }

    return NextResponse.json(
      { success: !bridgeError, dryRun: settings.dryRun, todayIso, generated, applied, bridgeError, notified: 0 },
      { status: bridgeError ? 500 : 200 },
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
