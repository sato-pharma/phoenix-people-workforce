import { NextResponse } from "next/server";

import { currentCairoDateParts } from "@/lib/i18n/format";
import {
  autoConfirmElapsedDigests,
  generateDigestsForCompletedWeek,
  getDigestSettings,
  sendDraftDigests,
} from "@/lib/attendance/digest-service.ts";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The weekly digest's whole clock, in three steps, in this order:
 *
 *   1. generate — build digests for the settlement week that has CLOSED
 *   2. send     — deliver drafts and start each one's response window
 *   3. auto-confirm — settle anything whose window has now elapsed
 *
 * Order matters. Auto-confirm runs LAST so a digest can never be generated, sent and
 * auto-confirmed inside one invocation: step 2 stamps `auto_confirm_at` in the
 * future, so step 3 cannot see it. Running them the other way round would collapse
 * the employee's entire window into the gap between two statements.
 *
 * Safe to call more often than weekly. Generation skips a week it has already built,
 * sending only picks up drafts, and auto-confirm only touches an elapsed window — so
 * a daily or hourly schedule simply makes the auto-confirm sweep punctual rather than
 * doing the week's work repeatedly.
 *
 * `enabled` is checked first and reported honestly: a disabled module returns
 * `skipped: "disabled"` rather than a cheerful zero, because "0 sent" and "switched
 * off" are indistinguishable otherwise — which is exactly how the outbox drain ran
 * perfectly and did nothing for 13 days.
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
    const sent = await sendDraftDigests();
    const autoConfirmed = await autoConfirmElapsedDigests(new Date().toISOString());

    return NextResponse.json({
      success: true,
      dryRun: settings.dryRun,
      todayIso,
      generated,
      sent,
      autoConfirmed,
    });
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
