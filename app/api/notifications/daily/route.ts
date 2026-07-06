import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

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

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Every Vercel environment (production, preview, `vercel dev`) sets VERCEL — only a
  // real local machine without it may bypass an unset CRON_SECRET during development.
  if (!secret) return !process.env.VERCEL && process.env.NODE_ENV === "development";
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
    runBirthdayNotifications(request),
    runContractRenewalNotifications(request),
    runHolidayConfirmationReminder(request),
    runVacationSlaDaily(),
    runMarketingSlaDaily(),
    runRecruitmentDailyNotifications(),
    runTelegramDailyHrDigest(),
    runOutstationGeocodeWarmup(),
    runOutstationHighRiskDigest(),
    runFieldWorkforceComplianceDigest(),
    runFieldWorkforceComplianceDeductionsAutoSync().catch((e: unknown) => ({ ok: false as const, months: [] as const, error: String(e) })),
    runExcuseSlaDaily().catch((e) => ({ processed: 0, errors: 1, detail: String(e) })),
    runOutstationSlaDaily().catch((e) => ({ processed: 0, errors: 1, detail: String(e) })),
    runResignationSlaDaily().catch((e) => ({ processed: 0, errors: 1, detail: String(e) })),
    runWeeklyPlansDriftCheck().catch((e: unknown) => ({ ok: false as const, anomalies: 0 as const, driftCodes: [] as const, sentCount: 0 as const, error: String(e) })),
    pruneExpiredRateLimitBuckets().catch((e: unknown) => ({ deleted: 0, error: String(e) })),
  ]);
  const [birthdays, contractRenewals, holidayConfirmation] = await Promise.all([
    birthdayResponse.json(),
    contractRenewalResponse.json(),
    holidayConfirmationResponse.json(),
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
    return await Sentry.withMonitor(
      "daily-notification-dispatcher",
      () => runDailyNotifications(request),
      {
        schedule: { type: "crontab", value: "30 6 * * *" },
        checkinMargin: 60,
        maxRuntime: 60,
        timezone: "Etc/UTC",
      },
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { cron: "daily-notification-dispatcher" } });
    const message = error instanceof Error ? error.message : "Daily notification run failed.";
    return NextResponse.json({ error: "daily_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
