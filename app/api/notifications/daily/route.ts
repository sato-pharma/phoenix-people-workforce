import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/config/system-settings";
import { logCronUnauthorized, logError } from "@/lib/observability/log";

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
    runMarketingSlaDaily().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-marketing-sla" } });
      return { success: false, error: String(e) };
    }),
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
    // Probation weekly Double-Visit digest (MOD-1) — self-gates to one Cairo weekday, replacing the
    // per-DV-day snapshot email. Safe to call daily; a non-digest day is a no-op.
    processProbationWeeklyDigest().catch((e: unknown) => {
      console.error(e, { tags: { cron: "probation-weekly-digest" } });
      return { scanned: 0, sent: 0, error: String(e) };
    }),
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
    runOutstationSlaDaily().catch((e) => {
      console.error(e, { tags: { cron: "daily-outstation-sla" } });
      return { processed: 0, errors: 1, detail: String(e) };
    }),
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
  ]);
  const [birthdays, contractRenewals, holidayConfirmation] = await Promise.all([
    birthdayResponse instanceof Response ? birthdayResponse.json() : birthdayResponse,
    contractRenewalResponse instanceof Response ? contractRenewalResponse.json() : contractRenewalResponse,
    holidayConfirmationResponse instanceof Response ? holidayConfirmationResponse.json() : holidayConfirmationResponse,
  ]);

  return NextResponse.json({
    birthdays,
    contractRenewals,
    excuseSla,
    fieldWorkforceComplianceDeductionsAutoSync,
    fieldWorkforceComplianceDigest,
    holidayConfirmation,
    marketingSla,
    outstationGeocodeWarmup,
    outstationSla,
    rateLimitPrune,
    errorEventsPrune,
    recruitment,
    resignationSla,
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
    return await runDailyNotifications(request);
  } catch (error) {
    logError("Daily notification dispatcher failed", { labels: { event: "cron_failed", job: "notifications/daily" }, error });
    const message = error instanceof Error ? error.message : "Daily notification run failed.";
    return NextResponse.json({ error: "daily_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
