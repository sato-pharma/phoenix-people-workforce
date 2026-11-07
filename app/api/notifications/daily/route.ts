import { NextResponse } from "next/server";
import { logError, logInfo } from "@/lib/observability/log";
import { pingDeadMansSwitch, signalDeadMansSwitchStart } from "@/lib/observability/dead-mans-switch";

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
import { runNeedsYouDailyDigest } from "@/lib/needs-you/deliver/daily";
import { runNeedsYouWeeklyEmail } from "@/lib/needs-you/deliver/weekly";
import { runTelegramDailyHrDigest } from "@/lib/notifications/telegram-operations";
import { runOutstationGeocodeWarmup } from "@/lib/outstation/geocode-warmup";
import { runExcuseSlaDaily } from "@/lib/excuses/service";
import {
  runOutstationDeparturePhotoReminders,
  runOutstationSlaDaily,
  runOutstationWorkloadRestamp,
} from "@/lib/outstation/service";
import { runDeadTelegramLinkAlert } from "@/lib/notifications/dead-telegram-link-alert";
import { processProbationMilestoneEmails } from "@/lib/probation/intelligence/milestone-emails";
import { runResignationSlaDaily } from "@/lib/resignations/service";
import { runWeeklyPlansDriftCheck } from "@/lib/weekly-planning/drift-check";
import { runExcuseDriftCheck } from "@/lib/excuses/drift-check";
import { pruneExpiredRateLimitBuckets } from "@/lib/security/api-rate-limit";
import { pruneOldAppErrorEvents } from "@/lib/error-monitor/service";
import { runSosMonthlyClosingReportCheck } from "@/lib/sales/sos-report-delivery";
import { runMilestoneDueNotices } from "@/lib/milestones/notices";
import { notifyInactiveUsers } from "@/lib/notifications/inactive-user-digest";
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
      // The run summary and the cron response carry the REDACTED message: a database or network
      // error's raw text is a map of the inside. The real error is logged on the next line, so the
      // redaction itself is not reported a second time ({ report: false }).
      const message = clientSafeErrorMessage(error, `${job} failed.`, { report: false });
      failures.push({ job, message });
      logError(`Daily cron sub-job failed: ${job}`, { labels: { event: "cron_failed", job }, error });
      return fallback(message);
    };
  }

  // 🔴 THE NEEDS YOU BOARD RUNS ON ITS OWN, BEFORE THE FAN-OUT, AND THAT IS THE WHOLE POINT OF
  // THIS BLOCK. The board is not one query — it is 22 sources behind its own two-lane
  // scheduler (heavy ONE at a time, light four, each source racing an 8-second budget). Those
  // lanes stop the sources starving EACH OTHER; they cannot stop the other 30 sub-jobs below
  // starving them. Run as a passenger in the fan-out it lost sources every single morning:
  // measured on production, 06:36 Cairo, 15 consecutive days from 2026-10-09, 1-5 sources ambered
  // per run, with "Other approvals inbox" and "Published closings that have moved" — both `heavy`
  // — failing on every one of them. That is the SAME defect the lanes were built to remove, one
  // level up: the budget was being spent queueing rather than querying.
  //
  // 🔴 SO DO NOT MOVE THIS BACK INTO THE Promise.all, AND DO NOT "FIX" A RETURNING AMBER ROW BY
  // WIDENING A LANE OR RAISING THE 8-SECOND BUDGET — that trades the board's honesty for a green
  // digest, which is the one thing this module refuses to do. Make a heavy source cheaper instead,
  // which changes what it measures and is the owner's call.
  //
  // The result is handed to the fan-out at its OWN position (26) as an already-settled promise, so
  // every position below keeps its meaning. The positional destructure under this comment has been
  // silently broken twice by an insert; it is not worth a third time to save one line.
  const needsYouDailyResult = await runNeedsYouDailyDigest().catch(
    onJobFailure("needs-you-daily-digest", (message) => ({
      delivered: 0,
      notProven: 0,
      reason: message,
      skipped: true,
    })),
  );

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
    heldNotificationReminder,
    // Two entries that used to sit BEYOND the destructure's end are now named, in their Promise.all
    // order — adding a Promise.all entry without its name here is the exact off-by-one the comments
    // above record. `heldNotificationExpiry` was always unnamed (position 23); `milestoneDueNotices`
    // is the new milestones pump (position 24). Both must stay LAST, in this order — and
    // `inactiveUserDigest` (position 25, added 2026-09-26) after them.
    heldNotificationExpiry,
    milestoneDueNotices,
    inactiveUserDigest,
    // Position 26, added 2026-09-28. APPENDED, never inserted: positions 1-25 keep their meaning,
    // which is the only way to add one without re-running the off-by-one above.
    needsYouDailyDigest,
    // Position 27, added 2026-09-28. Appended for the same reason as 26.
    needsYouWeeklyEmail,
    // Position 28 was the iReports360 account-setup reminder, retired 2026-11-07 with the vendor CRM
    // (crm_cutover.vendor_sync_retired_at, 6 Nov 2026 — nobody can be given an iReports360 account
    // any more). Its name and its Promise.all entry left TOGETHER, so every name below still lines
    // up with its own entry; the position numbers in the comments below are each one lower now.
    // Position 29, added 2026-09-28. Appended for the same reason as 26, 27 and 28.
    deadTelegramLinkAlert,
    // Position 30, added 2026-09-29. Appended for the same reason as 26-29.
    probationMilestoneEmails,
    // Position 31, added 2026-10-22. Appended for the same reason as 26-30.
    outstationWorkloadRestamp,
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
    // Retired 2026-10-23: the weekly system health digest, which summarised the retired System
    // Issues page. The System Audit daily message (src/lib/system-audit/daily-message.ts) replaces
    // it; its name and its result left this list together,
    // so every position below is still aligned.
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
    // Reminds the milestones audience (Super Admin) that a service milestone or a birthday is
    // coming up, so a card can be printed in time. Keeps reminding daily until a recipient opens
    // the Milestones page — the owner's chosen acknowledgement (2026-09-23). Never throws.
    runMilestoneDueNotices().catch(
      onJobFailure("daily-milestone-due", (message) => ({ delivered: 0, occasions: 0, skipped: true, reason: message })),
    ),
    // Tells the Super Admin, in-app and on Telegram, who has not signed in to Phoenix for a week
    // or more. It used to be computed on the FIVE-MINUTE cron and printed to the log as five names
    // and an ellipsis — nobody received it. Owner's decision, 2026-09-26: daily, never email.
    notifyInactiveUsers().catch(
      onJobFailure("daily-inactive-user-digest", (message) => ({
        delivered: 0,
        inactiveCount: 0,
        skipped: true,
        reason: message,
      })),
    ),
    // The Needs You board, once a morning, in-app and on Telegram — never email (one email to him is
    // already three deliveries, so that one is weekly). It rides HERE rather than on a schedule of
    // its own: a dedicated cron would cost a JOB_SCHEDULES declaration, a cronjob-sync row, a request
    // against the 100-per-DAY REST cap, and the heartbeat-parity contract that pages every Super
    // Admin every 15 minutes when a declared job stops reporting.
    //
    // 🔴 The fallback reports `skipped: true` with the reason, and NEVER a zero that reads as
    // "nothing was waiting". A board that under-reports is worse than no board, and that rule has to
    // survive the job failing, not just the sources failing. It now sits on the awaited call ABOVE
    // this fan-out — this entry is the settled result taking its own position, NOT a second run.
    // `onJobFailure` has already pushed any failure onto `failures`, so the run summary, the
    // dead man's switch and `totalJobs` all still count this job exactly once.
    Promise.resolve(needsYouDailyResult),
    // The WHOLE board by email, Sundays. It self-gates to the weekday and returns
    // `skipped: "not the weekly email day"` on the other six — so it costs one cheap call a day and
    // no schedule of its own.
    //
    // Email rather than Telegram because it is COMPLETE: every item in every lane plus all sixteen
    // source verdicts, which cannot fit in Telegram's 900 characters. It never requests the telegram
    // channel — the email already mirrors a preview there on its way out.
    runNeedsYouWeeklyEmail().catch(
      onJobFailure("needs-you-weekly-email", (message) => ({
        delivered: 0,
        notProven: 0,
        reason: message,
        skipped: true,
      })),
    ),
    // Retired 2026-11-07: the daily reminder that a new hire was still waiting for an iReports360
    // account. The vendor CRM was retired on 6 Nov 2026 and Phoenix CRM is the only source of field
    // work, so there is no account left to wait for. Its name and its result left this list
    // together, so every position below is still aligned. Never re-wire it.
    // Telegram messages being thrown away because the recipient has no working link. Measured
    // 2026-09-28: NOT ONE link in the company was active, and 1,656 messages had been dropped that
    // way — 448 to the CEO alone — with nothing red anywhere, because the delivery is recorded as
    // "skipped", the same word used when a channel is deliberately switched off.
    //
    // 🔴 It alerts on LIVE loss in a 24h window, not on a list of broken links, so it falls silent
    // by itself the moment the links are fixed. In-app ALONE: the channel it is about is the dead
    // one, so a Telegram notice would be swallowed by the very fault it reports.
    runDeadTelegramLinkAlert().catch(
      onJobFailure("dead-telegram-link-alert", (message) => ({
        delivered: 0,
        dropped: 0,
        people: 0,
        skippedReason: message,
      })),
    ),
    // Probation Day 30 / 60 / 75 milestone emails (owner, 2026-09-29; since 2026-10-20 To Omar
    // Gawish alone). On the DAILY cron rather than the 5-minute one the retired fan-out used — a
    // milestone is a calendar event, and one idempotent pass a day is all it needs.
    processProbationMilestoneEmails().catch(
      onJobFailure("daily-probation-milestone-emails", (message) => ({
        scanned: 0,
        sent: 0,
        error: message,
      })),
    ),
    // Re-reads the CRM for an undecided trip whose AM · PM · Pharmacies were stamped before the
    // day's visits were typed (owner, 2026-10-22 — workload-stamp.ts), and rewrites the stamp only
    // when the CRM now holds MORE work. Evidence only: no money, no gate, no message to anyone.
    runOutstationWorkloadRestamp().catch(
      onJobFailure("daily-outstation-workload-restamp", (message) => ({
        checked: 0,
        errors: 1,
        restamped: 0,
        error: message,
      })),
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
  // under-reports (29 since the iReports360 account-setup reminder retired 2026-11-07; 30 since the
  // weekly system health digest retired 2026-10-23; 31 since the
  // outstation workload refresh was added 2026-10-22; 30 since the
  // probation Day 30/60/75 milestone emails were added 2026-09-29;
  // 29 since the dead-Telegram-link alert was added 2026-09-28; 28 since the CRM
  // account-setup reminder the same day; 27 since the
  // Needs You weekly email, the same day as the
  // daily digest below it; 26 since that daily digest; 25 since the
  // inactive-colleague digest moved here from the 5-minute cron on 2026-09-26; 24 since the
  // milestones due-notice pump was added 2026-09-23; 23 before that, since the FWC deductions
  // auto-sync was retired in the C6 cutover on 2026-08-30).
  const totalJobs = 29;
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
    heldNotificationExpiry,
    holidayConfirmation,
    inactiveUserDigest,
    marketingAssignmentBackfill,
    milestoneDueNotices,
    marketingSla,
    needsYouDailyDigest,
    deadTelegramLinkAlert,
    needsYouWeeklyEmail,
    notificationRetention,
    outstationGeocodeWarmup,
    outstationSla,
    probationMilestoneEmails,
    outstationDeparturePhotoReminders,
    outstationWorkloadRestamp,
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
  // The start signal comes BEFORE the run so a container swap that kills it mid-way (06:37 on
  // 2026-10-16) reads "started, never finished" at Healthchecks instead of an unexplained silence.
  // Every path out of runDailyNotifications ends in a success or fail ping, so a start is never orphaned.
  await signalDeadMansSwitchStart("phoenix-notify-daily");
  try {
    return await runDailyNotifications(request);
  } catch (error) {
    logError("Daily notification dispatcher failed", { labels: { event: "cron_failed", job: "notifications/daily" }, error });
    // A total dispatcher crash never reaches the per-run ping inside runDailyNotifications above,
    // so it needs its own — this is the single most important case for the external monitor to
    // catch (nothing about this run's outcome would otherwise leave the app at all).
    // The external monitor gets the same redacted text as the response; the real error is in the log above.
    const message = clientSafeErrorMessage(error, "Daily notification run failed.");
    await pingDeadMansSwitch("phoenix-notify-daily", "fail", message);
    return NextResponse.json({ error: "daily_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
