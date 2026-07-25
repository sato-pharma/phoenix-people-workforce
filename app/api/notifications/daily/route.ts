import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isProductionRuntime } from "@/config/system-settings";
import { logCronUnauthorized, logError, logInfo } from "@/lib/observability/log";

import { purgeOldActivityEvents } from "@/lib/activity/service";
import { cleanupOldNotificationData } from "@/lib/notifications/email";
import { runBirthdayNotifications } from "@/app/api/notifications/birthdays/route";
import { runContractRenewalNotifications } from "@/app/api/notifications/contract-renewals/route";
import { runHolidayConfirmationReminder } from "@/app/api/notifications/holiday-confirmation/route";
import { runVacationSlaDaily } from "@/lib/vacation/service";
import { runFieldWorkforceComplianceDigest } from "@/lib/field-workforce-compliance/digest";
import { runFieldWorkforceComplianceDeductionsAutoSync } from "@/lib/deductions-governance/connectors/field-workforce-compliance";
import { runMarketingSlaDaily } from "@/lib/marketing-requests/service";
import { runRecruitmentDailyNotifications } from "@/lib/recruitment/notifications";
import { runTelegramDailyHrDigest } from "@/lib/notifications/telegram-operations";
import { runWeeklySystemHealthDigest } from "@/lib/notifications/weekly-system-health-digest";
import { processProbationWeeklyDigest } from "@/lib/probation/intelligence/probation-emails";
import { runOutstationGeocodeWarmup } from "@/lib/outstation/geocode-warmup";
import { runExcuseSlaDaily } from "@/lib/excuses/service";
import { runOutstationSlaDaily } from "@/lib/outstation/service";
import { runResignationSlaDaily } from "@/lib/resignations/service";
import { runWeeklyPlansDriftCheck } from "@/lib/weekly-planning/drift-check";
import { runExcuseDriftCheck } from "@/lib/excuses/drift-check";
import { pruneExpiredRateLimitBuckets } from "@/lib/security/api-rate-limit";
import { pruneOldAppErrorEvents } from "@/lib/error-monitor/service";
import { runSosMonthlyClosingReportCheck } from "@/lib/sales/sos-report-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Every Vercel environment (production, preview, `vercel dev`) sets VERCEL — only a
  // real local machine without it may bypass an unset CRON_SECRET during development.
  if (!secret) return !isProductionRuntime();
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

type DailyJobFailure = { job: string; message: string };

async function runDailyNotifications(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Daily notification run is not authorized." }, { status: 401 });
  }

  // Truthful reporting for the 22 sub-jobs below (owner report 2026-07-25: "it says success even
  // when it's broken"). Each job keeps its own .catch() and fallback so one failure can never abort
  // the other 21 — but a swallowed failure used to leave NO trace an alert could match: 18 of the
  // 22 handlers logged via console.error passing a second "tags" argument, which is not a
  // console.error parameter at all (it is silently discarded, and no console-capture integration is
  // registered in sentry.server.config.ts). So those failures carried no `event=cron_failed` label,
  // matched no log-based metric, and the route still reported the run as successful.
  //
  // Now every failure goes through logError with the standard {event: "cron_failed", job} labels —
  // the same shape the four already-correct jobs used — and is collected here so the response can
  // say plainly which jobs failed.
  //
  // Deliberately still HTTP 200: this job's live Cloud Scheduler retryConfig has no
  // maxRetryAttempts and maxRetryDuration=0s (verified 2026-07-25), i.e. UNLIMITED retries. A 5xx
  // on partial failure would therefore re-run all 22 jobs repeatedly — risking the duplicate-email
  // incident this work exists to prevent. Making Cloud Scheduler itself go red needs a retry-config
  // change first; see the run-summary log below, which is what alerting should key on.
  const failures: DailyJobFailure[] = [];

  function onJobFailure<T>(job: string, fallback: (message: string) => T): (error: unknown) => T {
    return (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ job, message });
      logError(`Daily cron sub-job failed: ${job}`, { labels: { event: "cron_failed", job }, error });
      return fallback(message);
    };
  }

  const [
    birthdayResponse,
    contractRenewalResponse,
    holidayConfirmationResponse,
    vacationSla,
    marketingSla,
    recruitment,
    telegramDigest,
    weeklySystemHealthDigest,
    // Pre-existing off-by-one (found 2026-07-18): this name was missing, so every result from
    // here on was captured one position off (e.g. outstationGeocodeWarmup actually held the
    // probation digest's result). The jobs themselves were unaffected — each has its own
    // .catch() and runs regardless of destructuring position — only this diagnostic JSON
    // response was mislabeled.
    probationWeeklyDigest,
    outstationGeocodeWarmup,
    fieldWorkforceComplianceDigest,
    fieldWorkforceComplianceDeductionsAutoSync,
    excuseSla,
    outstationSla,
    resignationSla,
    weeklyPlansDrift,
    excuseDrift,
    rateLimitPrune,
    errorEventsPrune,
    notificationRetention,
    activityRetention,
    sosMonthlyReportCheck,
  ] = await Promise.all([
    runBirthdayNotifications(request).catch(
      onJobFailure("daily-birthday", (message) =>
        NextResponse.json({ error: "birthday_notifications_failed", message }, { status: 500 }),
      ),
    ),
    runContractRenewalNotifications(request).catch(
      onJobFailure("daily-contract-renewals", (message) =>
        NextResponse.json({ error: "contract_renewal_notifications_failed", message }, { status: 500 }),
      ),
    ),
    runHolidayConfirmationReminder(request).catch(
      onJobFailure("daily-holiday-confirmation", (message) =>
        NextResponse.json({ error: "holiday_confirmation_failed", message }, { status: 500 }),
      ),
    ),
    runVacationSlaDaily().catch(onJobFailure("daily-vacation-sla", (message) => ({ success: false, error: message }))),
    // Restored 2026-07-23 behind a real admin toggle (see "marketing_sla_reminder" in
    // role-recipients.ts) — the 2026-07-22 disable is now an enabled=false default, not a
    // code-level stub, so a Super Admin can re-enable it from the Email Control Center.
    runMarketingSlaDaily().catch(onJobFailure("daily-marketing-sla", (message) => ({ success: false, error: message }))),
    runRecruitmentDailyNotifications().catch(
      onJobFailure("daily-recruitment-notifications", (message) => ({ success: false, error: message })),
    ),
    runTelegramDailyHrDigest().catch(onJobFailure("daily-telegram-digest", (message) => ({ success: false, error: message }))),
    runWeeklySystemHealthDigest().catch(
      onJobFailure("weekly-system-health-digest", (message) => ({ delivered: 0, skipped: true, error: message, sourceWarnings: [] })),
    ),
    // Restored 2026-07-23 behind a real admin toggle (see "probation_weekly_dv_digest" in
    // role-recipients.ts) — self-gates to one Cairo weekday, replacing the per-DV-day snapshot
    // email; safe to call daily, a non-digest day or a disabled toggle is both a clean no-op.
    processProbationWeeklyDigest().catch(
      onJobFailure("probation-weekly-digest", (message) => ({ scanned: 0, sent: 0, error: message })),
    ),
    runOutstationGeocodeWarmup().catch(
      onJobFailure("daily-outstation-geocode-warmup", (message) => ({ success: false, error: message })),
    ),
    runFieldWorkforceComplianceDigest().catch(
      onJobFailure("daily-fwc-digest", (message) => ({ success: false, error: message })),
    ),
    runFieldWorkforceComplianceDeductionsAutoSync().catch(
      onJobFailure("daily-fwc-deductions-sync", (message) => ({ ok: false as const, months: [] as const, error: message })),
    ),
    runExcuseSlaDaily().catch(onJobFailure("daily-excuse-sla", (message) => ({ processed: 0, errors: 1, detail: message }))),
    // Restored 2026-07-23 behind a real admin toggle (see "outstation_sla_reminder" in
    // role-recipients.ts).
    runOutstationSlaDaily().catch(onJobFailure("daily-outstation-sla", (message) => ({ processed: 0, errors: 1, detail: message }))),
    runResignationSlaDaily().catch(
      onJobFailure("daily-resignation-sla", (message) => ({ processed: 0, errors: 1, detail: message })),
    ),
    runWeeklyPlansDriftCheck().catch(
      onJobFailure("daily-weekly-plans-drift", (message) => ({
        ok: false as const,
        anomalies: 0 as const,
        driftCodes: [] as const,
        sentCount: 0 as const,
        error: message,
      })),
    ),
    runExcuseDriftCheck().catch(
      onJobFailure("daily-excuse-drift", (message) => ({
        ok: false as const,
        anomalies: 0 as const,
        sentCount: 0 as const,
        error: message,
      })),
    ),
    pruneExpiredRateLimitBuckets().catch(onJobFailure("daily-rate-limit-prune", (message) => ({ deleted: 0, error: message }))),
    pruneOldAppErrorEvents().catch(onJobFailure("error-events-prune", (message) => ({ deleted: null, error: message }))),
    // Moved here from the 5-min notification-process cron (2026-07-19) — deleting old
    // notification/outbox rows doesn't need to happen 288x/day, once daily is enough.
    cleanupOldNotificationData().catch(
      onJobFailure("notification-retention", (message) => ({
        outboxDeleted: 0,
        outboxTerminalDeleted: 0,
        eventsRedacted: 0,
        error: message,
      })),
    ),
    // Activity Control Center retention: drop page-view events older than 90 days. Moved here
    // from the 5-min cron for the same reason as notification retention above.
    purgeOldActivityEvents(90).catch(
      onJobFailure("activity-retention", (message) => ({ cutoffIso: "", ok: false, error: message })),
    ),
    // Fires the CEO/Super-Admin SoS BI report exactly once, the first daily run after every
    // line's monthly closing for a period is published. See sos-report-delivery.ts for the
    // dedupe design (own marker in notification_outbox, not just Resend's idempotency key).
    runSosMonthlyClosingReportCheck().catch(
      onJobFailure("sos-monthly-report-check", (message) => ({
        checkedPeriods: [] as string[],
        sentPeriods: [] as string[],
        errors: [{ period: "unknown", error: message }],
      })),
    ),
  ]);
  const [birthdays, contractRenewals, holidayConfirmation] = await Promise.all([
    birthdayResponse instanceof Response ? birthdayResponse.json() : birthdayResponse,
    contractRenewalResponse instanceof Response ? contractRenewalResponse.json() : contractRenewalResponse,
    holidayConfirmationResponse instanceof Response ? holidayConfirmationResponse.json() : holidayConfirmationResponse,
  ]);

  // One structured line per run that states the real outcome. This — not the HTTP status, and not
  // the Sentry monitor check-in (which only proves the route executed) — is the signal to alert on:
  // `event="cron_run_summary" job="notifications/daily" failedCount>0`.
  const totalJobs = 22;
  if (failures.length > 0) {
    logError(
      `Daily notification run completed with ${failures.length} of ${totalJobs} sub-job(s) FAILED: ${failures.map((f) => f.job).join(", ")}`,
      {
        context: { failures },
        labels: {
          event: "cron_run_summary",
          failedCount: failures.length,
          job: "notifications/daily",
          outcome: "partial_failure",
          totalJobs,
        },
      },
    );
  } else {
    logInfo(`Daily notification run completed — all ${totalJobs} sub-jobs succeeded`, {
      labels: { event: "cron_run_summary", failedCount: 0, job: "notifications/daily", outcome: "success", totalJobs },
    });
  }

  return NextResponse.json({
    activityRetention,
    birthdays,
    contractRenewals,
    excuseSla,
    failedCount: failures.length,
    failedJobs: failures,
    fieldWorkforceComplianceDeductionsAutoSync,
    fieldWorkforceComplianceDigest,
    holidayConfirmation,
    marketingSla,
    notificationRetention,
    outstationGeocodeWarmup,
    outstationSla,
    probationWeeklyDigest,
    rateLimitPrune,
    errorEventsPrune,
    recruitment,
    resignationSla,
    sosMonthlyReportCheck,
    // Truthful: false when ANY sub-job failed. Previously hardcoded true, which is what made a
    // broken run indistinguishable from a healthy one.
    success: failures.length === 0,
    telegramDigest,
    totalJobs,
    weeklySystemHealthDigest,
    vacationSla,
    weeklyPlansDrift,
    excuseDrift,
  });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("notifications/daily", request);
    return NextResponse.json({ error: "unauthorized", message: "Daily notification run is not authorized." }, { status: 401 });
  }
  try {
    return await Sentry.withMonitor("notifications-daily", () => runDailyNotifications(request), {
      checkinMargin: 10,
      maxRuntime: 10,
      schedule: { type: "crontab", value: "36 6 * * *" },
      timezone: "Africa/Cairo",
    });
  } catch (error) {
    logError("Daily notification dispatcher failed", { labels: { event: "cron_failed", job: "notifications/daily" }, error });
    const message = error instanceof Error ? error.message : "Daily notification run failed.";
    return NextResponse.json({ error: "daily_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
