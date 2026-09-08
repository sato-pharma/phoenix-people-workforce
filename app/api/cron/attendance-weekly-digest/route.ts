import { NextResponse } from "next/server";

import { currentCairoDateParts } from "@/lib/i18n/format";
import { generateDigestsForCompletedWeek, getDigestSettings } from "@/lib/attendance/digest-service.ts";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The weekly digest's only scheduled work: build the digests for the settlement week
 * that has just CLOSED, open for answers immediately.
 *
 * There is nothing to send and nothing to sweep. The module notifies nobody (owner,
 * 2026-09-08), and with no notice there is no response window to expire — so the two
 * steps this route used to carry, `send` and `auto-confirm`, are gone rather than
 * disabled. An unanswered day writes no settlement and travels to the month-end
 * Deductions queue as Pending.
 *
 * Safe to call more often than weekly: generation skips a week it has already built,
 * so a daily schedule simply makes the new week punctual.
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

    return NextResponse.json({ success: true, dryRun: settings.dryRun, todayIso, generated, notified: 0 });
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
