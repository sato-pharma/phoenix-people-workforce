import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/config/system-settings";

import { runBirthdayNotifications } from "@/app/api/notifications/birthdays/route";
import { runContractRenewalNotifications } from "@/app/api/notifications/contract-renewals/route";
import { runHolidayConfirmationReminder } from "@/app/api/notifications/holiday-confirmation/route";
import { runVacationSlaDaily } from "@/lib/vacation/service";
import { runFieldWorkforceComplianceDigest } from "@/lib/field-workforce-compliance/digest";
import { runFieldWorkforceComplianceDeductionsAutoSync } from "@/lib/deductions-governance/connectors/field-workforce-compliance";
import { runMarketingSlaDaily } from "@/lib/marketing-requests/service";
import { runRecruitmentDailyNotifications } from "@/lib/recruitment/notifications";
import { runTelegramDailyHrDigest } from "@/lib/notifications/telegram-operations";
import { runOutstationGeocodeWarmup } from "@/lib/outstation/geocode-warmup";
import { runOutstationHighRiskDigest } from "@/lib/outstation/high-risk-digest";
import { runExcuseSlaDaily } from "@/lib/excuses/service";
import { runOutstationSlaDaily } from "@/lib/outstation/service";
import { runResignationSlaDaily } from "@/lib/resignations/service";
import { runWeeklyPlansDriftCheck } from "@/lib/weekly-planning/drift-check";
import { pruneExpiredRateLimitBuckets } from "@/lib/security/api-rate-limit";

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
    outstationGeocodeWarmup,
    outstationHighRisk,
    fieldWorkforceComplianceDigest,
    fieldWorkforceComplianceDeductionsAutoSync,
    excuseSla,
    outstationSla,
    resignationSla,
    weeklyPlansDrift,
    rateLimitPrune,
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
    runOutstationGeocodeWarmup().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-outstation-geocode-warmup" } });
      return { success: false, error: String(e) };
    }),
    runOutstationHighRiskDigest().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-outstation-high-risk-digest" } });
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
    pruneExpiredRateLimitBuckets().catch((e: unknown) => {
      console.error(e, { tags: { cron: "daily-rate-limit-prune" } });
      return { deleted: 0, error: String(e) };
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
    outstationHighRisk,
    outstationSla,
    rateLimitPrune,
    recruitment,
    resignationSla,
    success: true,
    telegramDigest,
    vacationSla,
    weeklyPlansDrift,
  });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Daily notification run is not authorized." }, { status: 401 });
  }
  try {
    return await runDailyNotifications(request);
  } catch (error) {
    console.error(error, { tags: { cron: "daily-notification-dispatcher" } });
    const message = error instanceof Error ? error.message : "Daily notification run failed.";
    return NextResponse.json({ error: "daily_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
