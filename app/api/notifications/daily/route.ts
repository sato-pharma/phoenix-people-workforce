import { NextResponse } from "next/server";
import { logError, logInfo } from "@/lib/observability/log";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";

import { purgeOldActivityEvents } from "@/lib/activity/service";
import { cleanupOldNotificationData } from "@/lib/notifications/email";
import { runBirthdayNotifications } from "@/app/api/notifications/birthdays/route";
import { runContractRenewalNotifications } from "@/app/api/notifications/contract-renewals/route";
import { runHolidayConfirmationReminder } from "@/app/api/notifications/holiday-confirmation/route";
import { runVacationSlaDaily } from "@/lib/vacation/service";
import { backfillMissingMarketingAssignmentEmails, runMarketingSlaDaily } from "@/lib/marketing-requests/service";
import { runRecruitmentDailyNotifications } from "@/lib/recruitment/notifications";
import { expireStaleHeldNotifications } from "@/lib/notifications/confidence-gate";
import { remindHeldNotifications } from "@/lib/notifications/held-notification-alert";
import { runTelegramDailyHrDigest } from "@/lib/notifications/telegram-operations";
import { runWeeklySystemHealthDigest } from "@/lib/notifications/weekly-system-health-digest";
import { runOutstationGeocodeWarmup } from "@/lib/outstation/geocode-warmup";
import { runExcuseSlaDaily } from "@/lib/excuses/service";
import { runOutstationDeparturePhotoReminders, runOutstationSlaDaily } from "@/lib/outstation/service";
import { runResignationSlaDaily } from "@/lib/resignations/service";
import { runWeeklyPlansDriftCheck } from "@/lib/weekly-planning/drift-check";
import { runExcuseDriftCheck } from "@/lib/excuses/drift-check";
import { pruneExpiredRateLimitBuckets } from "@/lib/security/api-rate-limit";
import { pruneOldAppErrorEvents } from "@/lib/error-monitor/service";
import { runSosMonthlyClosingReportCheck } from "@/lib/sales/sos-report-delivery";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type DailyJobFailure = { job: string; message: string };

async function runDailyNotifications(request: Request) {
  const denied = assertCronAuthorized(request, "notifications/daily", {
    message: "Daily notification run is not authorized.",
  });
  if (denied) return denied;

  // Truthful reporting for the 22 sub-jobs below (owner report 2026-07-25: "it says success even
  // when it's broken"). Each job keeps its own .catch() and fallback so one failure can never abort
  // the other 21 — but a swallowed failure used to leave NO trace an alert could match: 18 of the
  // 22 handlers logged via console.error passing a second "tags" argument, which is not a
  // console.error parameter at all (it is silently discarded, and nothing captures console output
  // into structured logs). So those failures carried no `event=cron_failed` label,
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
    // Was MISSING until 2026-08-29, which had silently re-broken the same off-by-one the
    // comment above records from 2026-07-18. This entry exists in the Promise.all — the
    // marketing assignment backfill, added by #2211 — but carried no name here, so every
    // result from this position down was captured one place off: `recruitment` actually held
    // the backfill, `telegramDigest` held recruitment, and the last two entries fell off the
    // end of the list entirely. The jobs themselves always ran (each has its own .catch());
    // only this diagnostic JSON reported the wrong one.
    marketingAssignmentBackfill,
    recruitment,
    telegramDigest,
    weeklySystemHealthDigest,
    // Pre-existing off-by-one (found 2026-07-18): this name was missing, so every result from
    // here on was captured one position off (e.g. outstationGeocodeWarmup actually held the
    // probation digest's result). The jobs themselves were unaffected — each has its own
    // .catch() and runs regardless of destructuring position — only this diagnostic JSON
    // response was mislabeled.
    outstationGeocodeWarmup,
    excuseSla,
    outstationSla,
    outstationDeparturePhotoReminders,
    resignationSla,
    weeklyPlansDrift,
    excuseDrift,
    rateLimitPrune,
    errorEventsPrune,
    notificationRetention,
    activityRetention,
    sosMonthlyReportCheck,
    // Must stay LAST and in the same position as its Promise.all entry — the 2026-07-18
    // off-by-one noted above happened exactly here, by adding a job without its name.
    heldNotificationReminder,
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
    // Catches a request whose approver was never told it arrived — a decision recorded outside the
    // app (straight into the database) skips the notify path entirely, and the request then sits on
    // someone's desk invisibly. NOT behind "marketing_sla_reminder": that toggle governs chasing an
    // approver who already knows, and it has been off since 2026-07-23, which is why the last miss
    // went unseen. Re-sends nothing — the unique idempotency key absorbs every already-notified rung.
    backfillMissingMarketingAssignmentEmails().catch(
      onJobFailure("daily-marketing-assignment-backfill", (message) => ({ checked: 0, dispatched: 0, requestCodes: [], error: message })),
    ),
    runRecruitmentDailyNotifications().catch(
      onJobFailure("daily-recruitment-notifications", (message) => ({ success: false, error: message })),
    ),
    runTelegramDailyHrDigest().catch(onJobFailure("daily-telegram-digest", (message) => ({ success: false, error: message }))),
    runWeeklySystemHealthDigest().catch(
      onJobFailure("weekly-system-health-digest", (message) => ({ delivered: 0, skipped: true, error: message, sourceWarnings: [] })),
    ),
    // Retired 2026-08-02: the probation weekly digest and the Field Workforce Compliance digest
    // were removed at the owner's request. The FWC DEDUCTIONS auto-sync that used to run here was
    // retired in the C6 deductions cutover (2026-08-30): it wrote into the legacy governance
    // `deduction_candidates` table (frozen since 2026-08-02, read by nothing outside the retired
    // module). The unified Deductions module's CRM collector (crm_visits_mirror ->
    // deductions_candidates) is the live no-activity path now — do NOT re-add this as a money job.
    runOutstationGeocodeWarmup().catch(
      onJobFailure("daily-outstation-geocode-warmup", (message) => ({ success: false, error: message })),
    ),
    runExcuseSlaDaily().catch(onJobFailure("daily-excuse-sla", (message) => ({ processed: 0, errors: 1, detail: message }))),
    // Restored 2026-07-23 behind a real admin toggle (see "outstation_sla_reminder" in
    // role-recipients.ts).
    runOutstationSlaDaily().catch(onJobFailure("daily-outstation-sla", (message) => ({ processed: 0, errors: 1, detail: message }))),
    // Reminds the EMPLOYEE his departure photo is due, on the trip's last day and once more when
    // it goes overdue. Not behind a toggle — see the note on the function for why an unregistered
    // toggle key would leave this silently dead.
    runOutstationDeparturePhotoReminders().catch(
      onJobFailure("daily-outstation-departure-photo", (message) => ({ processed: 0, errors: 1, detail: message })),
    ),
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
    // Keeps asking while any email sits held at /admin/notification-confidence. The hold-time
    // alert fires once and never repeats, which is how 30 held emails — including 8 password
    // resets and 4 account-setup links — went undelivered for up to 15 days (measured
    // 2026-08-08). A hold is only a safety mechanism if somebody eventually acts on it.
    remindHeldNotifications().catch(
      onJobFailure("held-notification-reminder", (message) => ({ delivered: 0, skipped: true, reason: message })),
    ),
    // Closes every hold that reached its deadline, and says so. The reminder above kept asking for
    // 27 consecutive days while 174 real emails stayed undelivered and the oldest reached 35 days
    // — asking is not a decision. This one decides: past HOLD_EXPIRY_HOURS a hold is discarded,
    // never released, because an unreviewed hold means an audience nobody signed off on. It does
    // NOT touch the pre-2026-08-28 backlog; see HOLD_EXPIRY_EFFECTIVE_FROM.
    expireStaleHeldNotifications().catch(
      onJobFailure("held-notification-expiry", (message) => ({ expired: 0, skipped: true, reason: message })),
    ),
  ]);
  const [birthdays, contractRenewals, holidayConfirmation] = await Promise.all([
    birthdayResponse instanceof Response ? birthdayResponse.json() : birthdayResponse,
    contractRenewalResponse instanceof Response ? contractRenewalResponse.json() : contractRenewalResponse,
    holidayConfirmationResponse instanceof Response ? holidayConfirmationResponse.json() : holidayConfirmationResponse,
  ]);

  // One structured line per run that states the real outcome. This — not the HTTP status, and not
  // the dead-man's-switch ping (which only proves the route executed) — is the signal to alert on:
  // `event="cron_run_summary" job="notifications/daily" failedCount>0`.
  // Hand-maintained: bump this whenever a sub-job is added above, or the run summary silently
  // under-reports (23 since the FWC deductions auto-sync was retired in the C6 cutover on 2026-08-30).
  const totalJobs = 23;
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

  // Slug matches the historical Cloud Scheduler job name (phoenix-notify-daily), not this
  // route's own path. GCP is dead (billing closed 2026-08-01) and cron-job.org runs production
  // now, but the slug is the dead man's switch's IDENTITY at Healthchecks — renaming it would
  // orphan the check and its history, so it stays as-is. Called
  // directly (not via the generic withDeadMansSwitch wrapper) so a PARTIAL sub-job failure — which
  // never throws, by design — still pings /fail instead of reporting a false "success" externally.
  await pingDeadMansSwitch(
    "phoenix-notify-daily",
    failures.length > 0 ? "fail" : "success",
    failures.length > 0 ? `${failures.length}/${totalJobs} sub-job(s) failed: ${failures.map((f) => f.job).join(", ")}` : undefined,
  );

  return NextResponse.json({
    activityRetention,
    birthdays,
    contractRenewals,
    excuseSla,
    failedCount: failures.length,
    failedJobs: failures,
    heldNotificationReminder,
    holidayConfirmation,
    marketingAssignmentBackfill,
    marketingSla,
    notificationRetention,
    outstationGeocodeWarmup,
    outstationSla,
    outstationDeparturePhotoReminders,
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
  const denied = assertCronAuthorized(request, "notifications/daily", {
    message: "Daily notification run is not authorized.",
  });
  if (denied) return denied;
  try {
    return await runDailyNotifications(request);
  } catch (error) {
    logError("Daily notification dispatcher failed", { labels: { event: "cron_failed", job: "notifications/daily" }, error });
    // A total dispatcher crash never reaches the per-run ping inside runDailyNotifications above,
    // so it needs its own — this is the single most important case for the external monitor to
    // catch (nothing about this run's outcome would otherwise leave the app at all).
    await pingDeadMansSwitch("phoenix-notify-daily", "fail", error instanceof Error ? error.message : String(error));
    const message = clientSafeErrorMessage(error, "Daily notification run failed.");
    return NextResponse.json({ error: "daily_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
