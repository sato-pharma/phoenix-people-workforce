import { NextResponse } from "next/server";

import { runMarketingFieldCaptureNudge } from "@/lib/marketing-requests/field-capture-backlog";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Tell each rep which of THEIR marketing customers still show a validated status with no field
 * capture behind them. In-app/Telegram/push only — bulk email is never fired from this system,
 * and 64 recipients is bulk by any reading.
 *
 * MOVED OFF THE DAILY BUNDLE 2026-08-29 (a bundle itself split into one job per schedule on
 * 13 Nov 2026, /api/cron/daily/<job>), because it was the sub-job that pushed
 * `phoenix-notify-daily` past the scheduler's ceiling. cron-job.org cuts every request at 30
 * seconds — a platform cap `requestTimeout` cannot raise — and the daily run had been a 5-9
 * second job all month until this nudge joined it in #2360 on 24 August 00:23 Cairo. The very
 * next run, 06:36 that morning, took 28.8s; by 29 August it was 34.1s and the scheduler had been
 * logging a red `Failed (timeout)` for two consecutive mornings.
 *
 * Those failures were false — Healthchecks recorded `success` on all 36 pings from 26 July to 29
 * August, and the daily route pings LAST, after every sub-job resolves, so the work always
 * finished after the client was cut. The cost was never a missed notification. It was the alarm:
 * a permanently red daily job is one nobody reads, which is exactly how the outbox drain hid for
 * 13 days while returning HTTP 200 every 5 minutes. Splitting the nudge out puts the daily run
 * back under the cap so its red means something again, and gives this job a clock of its own.
 *
 * Safe to run alongside a daily run that still calls it: the idempotency key carries the Cairo
 * date, so the second run of a given day re-sends nothing.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/marketing-field-capture-nudge");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-marketing-field-capture-nudge", () =>
      runMarketingFieldCaptureNudge(),
    );
    return NextResponse.json({
      success: true,
      customersCovered: result.customersCovered,
      notified: result.notified,
      skipped: result.skipped,
      unassignedCustomers: result.unassignedCustomers,
    });
  } catch (error) {
    logError("Marketing field-capture nudge failed", {
      labels: { event: "cron_failed", job: "marketing-field-capture-nudge" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Marketing field-capture nudge failed.");
    return NextResponse.json({ error: "marketing_field_capture_nudge_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
