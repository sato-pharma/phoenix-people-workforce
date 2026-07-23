import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isProductionRuntime } from "@/config/system-settings";
import { logCronUnauthorized, logError } from "@/lib/observability/log";

import { purgeOldActivityEvents } from "@/lib/activity/service";
import { cleanupOldNotificationData } from "@/lib/notifications/email";
import { runBirthdayNotifications } from "@/app/api/notifications/birthdays/route";
import { runContractRenewalNotifications } from "@/app/api/notifications/contract-renewals/route";
import { runHolidayConfirmationReminder } from "@/app/api/notifications/holiday-confirmation/route";
import { runVacationSlaDaily } from "@/lib/vacation/service";
import { runFieldWorkforceComplianceDigest } from "@/lib/field-workforce-compliance/digest";
import { runFieldWorkforceComplianceDeductionsAutoSync } from "@/lib/deductions-governance/connectors/field-workforce-compliance";
import { runRecruitmentDailyNotifications } from "@/lib/recruitment/notifications";
import { runTelegramDailyHrDigest } from "@/lib/notifications/telegram-operations";
import { runWeeklySystemHealthDigest } from "@/lib/notifications/weekly-system-health-digest";
import { runOutstationGeocodeWarmup } from "@/lib/outstation/geocode-warmup";
import { runExcuseSlaDaily } from "@/lib/excuses/service";
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

async function runDailyNotifications(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Daily notification run is not authorized." }, { status: 401 });
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
    runBirthdayNotifications(request).catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-birthday" } });
      return NextResponse.json({ error: "birthday_notifications_failed", message: String(e) }, { status: 500 });
    }),
    runContractRenewalNotifications(request).catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-contract-renewals" } });
      return NextResponse.json({ error: "contract_renewal_notifications_failed", message: String(e) }, { status: 500 });
    }),
    runHolidayConfirmationReminder(request).catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-holiday-confirmation" } });
      return NextResponse.json({ error: "holiday_confirmation_failed", message: String(e) }, { status: 500 });
    }),
    runVacationSlaDaily().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-vacation-sla" } });
      return { success: false, error: String(e) };
    }),
    // Disabled 2026-07-22 at owner request — marketing SLA reminder/escalation emails stopped.
    Promise.resolve({ errors: [], escalations: 0, overdue: 0, reminders: 0, runDate: "", scanned: 0, disabled: true }),
    runRecruitmentDailyNotifications().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-recruitment-notifications" } });
      return { success: false, error: String(e) };
    }),
    runTelegramDailyHrDigest().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-telegram-digest" } });
      return { success: false, error: String(e) };
    }),
    runWeeklySystemHealthDigest().catch((e: unknown) => {
      console.error(e, { tags: { cron: "weekly-system-health-digest" } });
      return { delivered: 0, skipped: true, error: String(e), sourceWarnings: [] };
    }),
    // Disabled 2026-07-22 at owner request — probation weekly Double-Visit digest stopped.
    Promise.resolve({ scanned: 0, sent: 0, disabled: true }),
    runOutstationGeocodeWarmup().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-outstation-geocode-warmup" } });
      return { success: false, error: String(e) };
    }),
    runFieldWorkforceComplianceDigest().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-fwc-digest" } });
      return { success: false, error: String(e) };
    }),
    runFieldWorkforceComplianceDeductionsAutoSync().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-fwc-deductions-sync" } });
      return { ok: false as const, months: [] as const, error: String(e) };
    }),
    runExcuseSlaDaily().catch((e) => {
      console.error(e, { tags: { cron: "daily-excuse-sla" } });
      return { processed: 0, errors: 1, detail: String(e) };
    }),
    // Disabled 2026-07-22 at owner request — outstation SLA reminder emails stopped.
    Promise.resolve({ processed: 0, errors: 0, disabled: true }),
    runResignationSlaDaily().catch((e) => {
      console.error(e, { tags: { cron: "daily-resignation-sla" } });
      return { processed: 0, errors: 1, detail: String(e) };
    }),
    runWeeklyPlansDriftCheck().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-weekly-plans-drift" } });
      return { ok: false as const, anomalies: 0 as const, driftCodes: [] as const, sentCount: 0 as const, error: String(e) };
    }),
    runExcuseDriftCheck().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-excuse-drift" } });
      return { ok: false as const, anomalies: 0 as const, sentCount: 0 as const, error: String(e) };
    }),
    pruneExpiredRateLimitBuckets().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-rate-limit-prune" } });
      return { deleted: 0, error: String(e) };
    }),
    pruneOldAppErrorEvents().catch((e: unknown) => {
      logError("app_error_events retention prune failed", { labels: { event: "cron_failed", job: "error-events-prune" }, error: e });
      return { deleted: null, error: String(e) };
    }),
    // Moved here from the 5-min notification-process cron (2026-07-19) — deleting old
    // notification/outbox rows doesn't need to happen 288x/day, once daily is enough.
    cleanupOldNotificationData().catch((e: unknown) => {
      logError("Notification retention cleanup failed", { labels: { event: "cron_failed", job: "notification-retention" }, error: e });
      return { outboxDeleted: 0, outboxTerminalDeleted: 0, eventsRedacted: 0, error: String(e) };
    }),
    // Activity Control Center retention: drop page-view events older than 90 days. Moved here
    // from the 5-min cron for the same reason as notification retention above.
    purgeOldActivityEvents(90).catch((e: unknown) => {
      logError("Activity events retention purge failed", { labels: { event: "cron_failed", job: "activity-retention" }, error: e });
      return { cutoffIso: "", ok: false, error: String(e) };
    }),
    // Fires the CEO/Super-Admin SoS BI report exactly once, the first daily run after every
    // line's monthly closing for a period is published. See sos-report-delivery.ts for the
    // dedupe design (own marker in notification_outbox, not just Resend's idempotency key).
    runSosMonthlyClosingReportCheck().catch((e: unknown) => {
      logError("SoS monthly-closing report check failed", { labels: { event: "cron_failed", job: "sos-monthly-report-check" }, error: e });
      return { checkedPeriods: [] as string[], sentPeriods: [] as string[], errors: [{ period: "unknown", error: String(e) }] };
    }),
  ]);
  const [birthdays, contractRenewals, holidayConfirmation] = await Promise.all([
    birthdayResponse instanceof Response ? birthdayResponse.json() : birthdayResponse,
    contractRenewalResponse instanceof Response ? contractRenewalResponse.json() : contractRenewalResponse,
    holidayConfirmationResponse instanceof Response ? holidayConfirmationResponse.json() : holidayConfirmationResponse,
  ]);

  return NextResponse.json({
    activityRetention,
    birthdays,
    contractRenewals,
    excuseSla,
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
    success: true,
    telegramDigest,
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
