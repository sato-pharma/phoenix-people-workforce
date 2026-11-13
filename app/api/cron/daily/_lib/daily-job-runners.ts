import { NextResponse } from "next/server";

import { purgeOldActivityEvents } from "@/lib/activity/service";
import { purgeExpiredTabletRecordings } from "@/lib/devices/headwind/recordings";
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
import type { DailyJobKey } from "@/lib/scheduled-jobs/daily-jobs";

/**
 * What each morning job RUNS — one entry per job in `DAILY_JOBS` (src/lib/scheduled-jobs/daily-jobs.ts),
 * and the type below refuses a key with no runner.
 *
 * 🔴 EVERY CALL HERE IS THE CALL THE OLD FAN-OUT MADE, WORD FOR WORD: the same function, the same
 * arguments, the same `.catch(onJobFailure(<the same job label>, <the same fallback>))`. Splitting the
 * morning into one schedule per job (owner, 13 Nov 2026) changed WHEN each runs and on which request,
 * never what it does, whom it tells or by which channel. The labels are the ones the run's
 * `event=cron_failed` log lines have always carried, so a search for `job=daily-birthday` still finds
 * every failure, before and after the split.
 *
 * `resultName` is the name the job's result carried in the old route's answer, kept so the answer a
 * person reads with `?wait=1` names the result the way it always did.
 *
 * This lives under `app/` rather than `src/lib/` because three of the jobs are exported from their own
 * route files (birthdays, contract renewals, holiday confirmation), and nothing in `src/lib/` imports
 * from `app/`.
 */

/** Records a failed job and hands back its fallback result — the old route's `onJobFailure`, unchanged. */
export type DailyJobFailureHandler = <T>(job: string, fallback: (message: string) => T) => (error: unknown) => T;

export type DailyJobRunner = {
  resultName: string;
  run: (request: Request, onJobFailure: DailyJobFailureHandler) => Promise<unknown>;
};

export const DAILY_JOB_RUNNERS: Readonly<Record<DailyJobKey, DailyJobRunner>> = {
  // 🔴 THE NEEDS YOU BOARD IS NOT ONE QUERY — it is 22 sources behind its own two-lane scheduler
  // (heavy ONE at a time, light four, each source racing an 8-second budget). As a passenger in the
  // old 31-way fan-out it lost 1-5 sources every morning for 15 mornings running (from 2026-10-09);
  // it was then awaited alone before the fan-out, and now it has a request and a minute of its own.
  // DO NOT "FIX" A RETURNING AMBER ROW BY WIDENING A LANE OR RAISING THE 8-SECOND BUDGET — that
  // trades the board's honesty for a green digest. Make a heavy source cheaper instead, which is the
  // owner's call.
  //
  // In-app and Telegram, never email (one email to him is already two deliveries, so that one is
  // weekly). 🔴 The fallback reports `skipped: true` with the reason, and NEVER a zero that reads as
  // "nothing was waiting": a board that under-reports is worse than no board, and that rule has to
  // survive the job failing, not just the sources failing.
  "needs-you-daily-digest": {
    resultName: "needsYouDailyDigest",
    run: (_request, onJobFailure) =>
      runNeedsYouDailyDigest().catch(
        onJobFailure("needs-you-daily-digest", (message) => ({
          delivered: 0,
          notProven: 0,
          reason: message,
          skipped: true,
        })),
      ),
  },
  birthday: {
    resultName: "birthdays",
    run: (request, onJobFailure) =>
      runBirthdayNotifications(request).catch(
        onJobFailure("daily-birthday", (message) =>
          NextResponse.json({ error: "birthday_notifications_failed", message }, { status: 500 }),
        ),
      ),
  },
  "contract-renewals": {
    resultName: "contractRenewals",
    run: (request, onJobFailure) =>
      runContractRenewalNotifications(request).catch(
        onJobFailure("daily-contract-renewals", (message) =>
          NextResponse.json({ error: "contract_renewal_notifications_failed", message }, { status: 500 }),
        ),
      ),
  },
  "holiday-confirmation": {
    resultName: "holidayConfirmation",
    run: (request, onJobFailure) =>
      runHolidayConfirmationReminder(request).catch(
        onJobFailure("daily-holiday-confirmation", (message) =>
          NextResponse.json({ error: "holiday_confirmation_failed", message }, { status: 500 }),
        ),
      ),
  },
  "vacation-sla": {
    resultName: "vacationSla",
    run: (_request, onJobFailure) =>
      runVacationSlaDaily().catch(onJobFailure("daily-vacation-sla", (message) => ({ success: false, error: message }))),
  },
  // Restored 2026-07-23 behind a real admin toggle (see "marketing_sla_reminder" in
  // role-recipients.ts) — the 2026-07-22 disable is now an enabled=false default, not a
  // code-level stub, so a Super Admin can re-enable it from the Email Control Center.
  "marketing-sla": {
    resultName: "marketingSla",
    run: (_request, onJobFailure) =>
      runMarketingSlaDaily().catch(onJobFailure("daily-marketing-sla", (message) => ({ success: false, error: message }))),
  },
  // Catches a request whose approver was never told it arrived — a decision recorded outside the
  // app (straight into the database) skips the notify path entirely, and the request then sits on
  // someone's desk invisibly. NOT behind "marketing_sla_reminder": that toggle governs chasing an
  // approver who already knows, and it has been off since 2026-07-23, which is why the last miss
  // went unseen. Re-sends nothing — the unique idempotency key absorbs every already-notified rung.
  // `app/api/cron/marketing-assignment-backfill` stays as the manual trigger for the same pass.
  "marketing-assignment-backfill": {
    resultName: "marketingAssignmentBackfill",
    run: (_request, onJobFailure) =>
      backfillMissingMarketingAssignmentEmails().catch(
        onJobFailure("daily-marketing-assignment-backfill", (message) => ({ checked: 0, dispatched: 0, requestCodes: [], error: message })),
      ),
  },
  "recruitment-notifications": {
    resultName: "recruitment",
    run: (_request, onJobFailure) =>
      runRecruitmentDailyNotifications().catch(
        onJobFailure("daily-recruitment-notifications", (message) => ({ success: false, error: message })),
      ),
  },
  "telegram-digest": {
    resultName: "telegramDigest",
    run: (_request, onJobFailure) =>
      runTelegramDailyHrDigest().catch(onJobFailure("daily-telegram-digest", (message) => ({ success: false, error: message }))),
  },
  // Retired 2026-10-23: the weekly system health digest (the System Audit daily message replaces it).
  // Retired 2026-08-02: the probation weekly digest and the Field Workforce Compliance digest, at the
  // owner's request. The FWC DEDUCTIONS auto-sync was retired in the C6 deductions cutover
  // (2026-08-30): it wrote into the legacy governance `deduction_candidates` table. The unified
  // Deductions module's CRM collector (crm_visits_mirror -> deductions_candidates) is the live
  // no-activity path now — do NOT re-add this as a money job.
  "outstation-geocode-warmup": {
    resultName: "outstationGeocodeWarmup",
    run: (_request, onJobFailure) =>
      runOutstationGeocodeWarmup().catch(
        onJobFailure("daily-outstation-geocode-warmup", (message) => ({ success: false, error: message })),
      ),
  },
  "excuse-sla": {
    resultName: "excuseSla",
    run: (_request, onJobFailure) =>
      runExcuseSlaDaily().catch(onJobFailure("daily-excuse-sla", (message) => ({ processed: 0, errors: 1, detail: message }))),
  },
  // Restored 2026-07-23 behind a real admin toggle (see "outstation_sla_reminder" in
  // role-recipients.ts).
  "outstation-sla": {
    resultName: "outstationSla",
    run: (_request, onJobFailure) =>
      runOutstationSlaDaily().catch(onJobFailure("daily-outstation-sla", (message) => ({ processed: 0, errors: 1, detail: message }))),
  },
  // Reminds the EMPLOYEE his departure photo is due, on the trip's last day and once more when
  // it goes overdue. Not behind a toggle — see the note on the function for why an unregistered
  // toggle key would leave this silently dead.
  "outstation-departure-photo": {
    resultName: "outstationDeparturePhotoReminders",
    run: (_request, onJobFailure) =>
      runOutstationDeparturePhotoReminders().catch(
        onJobFailure("daily-outstation-departure-photo", (message) => ({ processed: 0, errors: 1, detail: message })),
      ),
  },
  "resignation-sla": {
    resultName: "resignationSla",
    run: (_request, onJobFailure) =>
      runResignationSlaDaily().catch(
        onJobFailure("daily-resignation-sla", (message) => ({ processed: 0, errors: 1, detail: message })),
      ),
  },
  "weekly-plans-drift": {
    resultName: "weeklyPlansDrift",
    run: (_request, onJobFailure) =>
      runWeeklyPlansDriftCheck().catch(
        onJobFailure("daily-weekly-plans-drift", (message) => ({
          ok: false as const,
          anomalies: 0 as const,
          driftCodes: [] as const,
          sentCount: 0 as const,
          error: message,
        })),
      ),
  },
  "excuse-drift": {
    resultName: "excuseDrift",
    run: (_request, onJobFailure) =>
      runExcuseDriftCheck().catch(
        onJobFailure("daily-excuse-drift", (message) => ({
          ok: false as const,
          anomalies: 0 as const,
          sentCount: 0 as const,
          error: message,
        })),
      ),
  },
  "rate-limit-prune": {
    resultName: "rateLimitPrune",
    run: (_request, onJobFailure) =>
      pruneExpiredRateLimitBuckets().catch(onJobFailure("daily-rate-limit-prune", (message) => ({ deleted: 0, error: message }))),
  },
  "error-events-prune": {
    resultName: "errorEventsPrune",
    run: (_request, onJobFailure) =>
      pruneOldAppErrorEvents().catch(onJobFailure("error-events-prune", (message) => ({ deleted: null, error: message }))),
  },
  // Moved to the daily run from the 5-min notification-process cron (2026-07-19) — deleting old
  // notification/outbox rows doesn't need to happen 288x/day, once daily is enough.
  "notification-retention": {
    resultName: "notificationRetention",
    run: (_request, onJobFailure) =>
      cleanupOldNotificationData().catch(
        onJobFailure("notification-retention", (message) => ({
          outboxDeleted: 0,
          outboxTerminalDeleted: 0,
          eventsRedacted: 0,
          error: message,
        })),
      ),
  },
  // Activity Control Center retention: drop page-view events older than 90 days. Moved to the daily
  // run from the 5-min cron for the same reason as notification retention above.
  "activity-retention": {
    resultName: "activityRetention",
    run: (_request, onJobFailure) =>
      purgeOldActivityEvents(90).catch(
        onJobFailure("activity-retention", (message) => ({ cutoffIso: "", ok: false, error: message })),
      ),
  },
  // Fires the CEO/Super-Admin SoS BI report exactly once, the first daily run after every
  // line's monthly closing for a period is published. See sos-report-delivery.ts for the
  // dedupe design (own marker in notification_outbox, not just Resend's idempotency key).
  "sos-monthly-report-check": {
    resultName: "sosMonthlyReportCheck",
    run: (_request, onJobFailure) =>
      runSosMonthlyClosingReportCheck().catch(
        onJobFailure("sos-monthly-report-check", (message) => ({
          checkedPeriods: [] as string[],
          sentPeriods: [] as string[],
          errors: [{ period: "unknown", error: message }],
        })),
      ),
  },
  // Keeps asking while any email sits held at /admin/notification-confidence. The hold-time
  // alert fires once and never repeats, which is how 30 held emails — including 8 password
  // resets and 4 account-setup links — went undelivered for up to 15 days (measured
  // 2026-08-08). A hold is only a safety mechanism if somebody eventually acts on it.
  "held-notification-reminder": {
    resultName: "heldNotificationReminder",
    run: (_request, onJobFailure) =>
      remindHeldNotifications().catch(
        onJobFailure("held-notification-reminder", (message) => ({ delivered: 0, skipped: true, reason: message })),
      ),
  },
  // Closes every hold that reached its deadline, and says so. The reminder above kept asking for
  // 27 consecutive days while 174 real emails stayed undelivered and the oldest reached 35 days
  // — asking is not a decision. This one decides: past HOLD_EXPIRY_HOURS a hold is discarded,
  // never released, because an unreviewed hold means an audience nobody signed off on. It does
  // NOT touch the pre-2026-08-28 backlog; see HOLD_EXPIRY_EFFECTIVE_FROM. It runs a minute AFTER
  // the reminder, so the reminder still names a hold on the morning it is about to expire.
  "held-notification-expiry": {
    resultName: "heldNotificationExpiry",
    run: (_request, onJobFailure) =>
      expireStaleHeldNotifications().catch(
        onJobFailure("held-notification-expiry", (message) => ({ expired: 0, skipped: true, reason: message })),
      ),
  },
  // Reminds the milestones audience (Super Admin) that a service milestone or a birthday is
  // coming up, so a card can be printed in time. Keeps reminding daily until a recipient opens
  // the Milestones page — the owner's chosen acknowledgement (2026-09-23). Never throws.
  "milestone-due": {
    resultName: "milestoneDueNotices",
    run: (_request, onJobFailure) =>
      runMilestoneDueNotices().catch(
        onJobFailure("daily-milestone-due", (message) => ({ delivered: 0, occasions: 0, skipped: true, reason: message })),
      ),
  },
  // Tells the Super Admin, in-app and on Telegram, who has not signed in to Phoenix for a week
  // or more. Owner's decision, 2026-09-26: daily, never email.
  "inactive-user-digest": {
    resultName: "inactiveUserDigest",
    run: (_request, onJobFailure) =>
      notifyInactiveUsers().catch(
        onJobFailure("daily-inactive-user-digest", (message) => ({
          delivered: 0,
          inactiveCount: 0,
          skipped: true,
          reason: message,
        })),
      ),
  },
  // The WHOLE board by email, Sundays. It self-gates to the weekday and returns
  // `skipped: "not the weekly email day"` on the other six — one cheap call a day.
  //
  // Email rather than Telegram because it is COMPLETE: every item in every lane plus all sixteen
  // source verdicts, which cannot fit in Telegram's 900 characters. It never requests the telegram
  // channel — the email already mirrors a preview there on its way out.
  "needs-you-weekly-email": {
    resultName: "needsYouWeeklyEmail",
    run: (_request, onJobFailure) =>
      runNeedsYouWeeklyEmail().catch(
        onJobFailure("needs-you-weekly-email", (message) => ({
          delivered: 0,
          notProven: 0,
          reason: message,
          skipped: true,
        })),
      ),
  },
  // Retired 2026-11-07: the daily reminder that a new hire was still waiting for an iReports360
  // account. The vendor CRM was retired on 6 Nov 2026. Never re-wire it.
  //
  // Telegram messages being thrown away because the recipient has no working link. Measured
  // 2026-09-28: NOT ONE link in the company was active, and 1,656 messages had been dropped that
  // way — 448 to the CEO alone — with nothing red anywhere.
  //
  // 🔴 It alerts on LIVE loss in a 24h window, not on a list of broken links, so it falls silent
  // by itself the moment the links are fixed. In-app ALONE: the channel it is about is the dead
  // one, so a Telegram notice would be swallowed by the very fault it reports.
  "dead-telegram-link-alert": {
    resultName: "deadTelegramLinkAlert",
    run: (_request, onJobFailure) =>
      runDeadTelegramLinkAlert().catch(
        onJobFailure("dead-telegram-link-alert", (message) => ({
          delivered: 0,
          dropped: 0,
          people: 0,
          skippedReason: message,
        })),
      ),
  },
  // Probation Day 30 / 60 / 75 milestone emails (owner, 2026-09-29; since 2026-10-20 To Omar
  // Gawish alone). Daily rather than every five minutes — a milestone is a calendar event, and one
  // idempotent pass a day is all it needs. `app/api/cron/probation-milestones` stays as the manual
  // trigger for the same sweep.
  "probation-milestone-emails": {
    resultName: "probationMilestoneEmails",
    run: (_request, onJobFailure) =>
      processProbationMilestoneEmails().catch(
        onJobFailure("daily-probation-milestone-emails", (message) => ({
          scanned: 0,
          sent: 0,
          error: message,
        })),
      ),
  },
  // Re-reads the CRM for an undecided trip whose AM · PM · Pharmacies were stamped before the
  // day's visits were typed (owner, 2026-10-22 — workload-stamp.ts), and rewrites the stamp only
  // when the CRM now holds MORE work. Evidence only: no money, no gate, no message to anyone.
  "outstation-workload-restamp": {
    resultName: "outstationWorkloadRestamp",
    run: (_request, onJobFailure) =>
      runOutstationWorkloadRestamp().catch(
        onJobFailure("daily-outstation-workload-restamp", (message) => ({
          checked: 0,
          errors: 1,
          restamped: 0,
          error: message,
        })),
      ),
  },
  // Tablet screen recordings are kept 90 days (owner, 2026-11-13): the file, then its row, and the
  // count of each comes back in this run's answer. A failed file removal keeps the row for tomorrow.
  "tablet-recording-retention": {
    resultName: "tabletRecordingRetention",
    run: (_request, onJobFailure) =>
      purgeExpiredTabletRecordings().catch(
        onJobFailure("tablet-recording-retention", (message) => ({
          cutoffIso: "",
          expired: 0,
          filesRemoved: 0,
          rowsDeleted: 0,
          error: message,
        })),
      ),
  },
};
