import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runDistributorUploadOverdueNudge } from "@/lib/sales/distributor-upload-nudge";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Tell Super Admin and the SFE Manager which distributor files for the month just closed are later
 * than they were last month.
 *
 * Owner decision 2026-09-03, asked directly: "sfe" and "You + Super Admins" for the audience, and
 * "only when a file passes its own date" for the trigger — silent on a month that is merely
 * incomplete, which is the normal state of the first week.
 *
 * In-app/Telegram/push only, never email. House rule for lateness reminders since 2026-07-25.
 *
 * A CLOCK OF ITS OWN rather than a seat on `phoenix-notify-daily`, following the field-capture and
 * invoice-overdue splits. That bundle then carried its sub-jobs against cron-job.org's unraisable
 * 30-second cut; adding another is the move that created that problem in the first place. (On
 * 13 Nov 2026 the bundle itself was split: every morning job now has its own clock, /api/cron/daily/<job>.)
 *
 * Safe to run more than once a day: the idempotency key carries the Cairo date AND the summed days
 * overdue, so a repeat run re-sends nothing while tomorrow's larger figure still gets through.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/distributor-upload-overdue-nudge");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-distributor-upload-overdue-nudge", () =>
      runDistributorUploadOverdueNudge(),
    );
    return NextResponse.json({
      success: true,
      locked: result.locked,
      notified: result.notified,
      overdue: result.overdue,
      period: result.period,
      skipped: result.skipped,
      warnings: result.warnings,
    });
  } catch (error) {
    logError("Distributor upload overdue nudge failed", {
      labels: { event: "cron_failed", job: "distributor-upload-overdue-nudge" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Distributor upload overdue nudge failed.");
    return NextResponse.json({ error: "distributor_upload_overdue_nudge_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
