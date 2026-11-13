import { NextResponse } from "next/server";

import { runMarketingInvoiceOverdueNudge } from "@/lib/marketing-requests/invoice-overdue-nudge";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Tell the requester and finance that an approved marketing request's invoice has passed its
 * deadline. Owner decision 2026-08-29: "the requester and finance".
 *
 * In-app/Telegram/push only, never email — the owner retired email for marketing lateness reminders
 * on 2026-07-25 after this exact shape produced a real incident, and `marketing-sla-channel-guard.ts`
 * blocks `invoice_overdue` as a hard post-filter so no call-site or fallback can restore it.
 *
 * A CLOCK OF ITS OWN rather than a seat on `phoenix-notify-daily`, following the field-capture nudge
 * split of 2026-08-29. That daily bundle then carried 22 sub-jobs (split into one job per schedule
 * on 13 Nov 2026, /api/cron/daily/<job>) and had been logging a red
 * `Failed (timeout)` against cron-job.org's unraisable 30-second cut; adding a 23rd is the move that
 * created that problem in the first place. This job is small today — four finance rows in
 * production — but "small" was true of the field-capture nudge too, on the day it joined.
 *
 * Safe to run more than once a day: the idempotency key carries the Cairo date AND the summed day
 * count, so a repeat run re-sends nothing while tomorrow's larger count still gets through.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/marketing-invoice-overdue-nudge");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-marketing-invoice-overdue-nudge", () =>
      runMarketingInvoiceOverdueNudge(),
    );
    return NextResponse.json({
      success: true,
      financeNotified: result.financeNotified,
      financeWarnings: result.financeWarnings,
      overdueInvoices: result.overdueInvoices,
      requestersNotified: result.requestersNotified,
      skipped: result.skipped,
    });
  } catch (error) {
    logError("Marketing invoice overdue nudge failed", {
      labels: { event: "cron_failed", job: "marketing-invoice-overdue-nudge" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Marketing invoice overdue nudge failed.");
    return NextResponse.json({ error: "marketing_invoice_overdue_nudge_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
