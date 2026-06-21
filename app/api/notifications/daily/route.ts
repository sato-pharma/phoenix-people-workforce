import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { runBirthdayNotifications } from "@/app/api/notifications/birthdays/route";
import { runContractRenewalNotifications } from "@/app/api/notifications/contract-renewals/route";
import { runVacationSlaDaily } from "@/lib/vacation/service";
import { runMarketingSlaDaily } from "@/lib/marketing-requests/service";
import { runRecruitmentDailyNotifications } from "@/lib/recruitment/notifications";
import { runTelegramDailyHrDigest } from "@/lib/notifications/telegram-operations";
import { runOutstationGeocodeWarmup } from "@/lib/outstation/geocode-warmup";
import { runOutstationHighRiskDigest } from "@/lib/outstation/high-risk-digest";
import { runExcuseSlaDaily } from "@/lib/excuses/service";
import { runOutstationSlaDaily } from "@/lib/outstation/service";
import { runResignationSlaDaily } from "@/lib/resignations/service";
import { runWeeklyPlansDriftCheck } from "@/lib/weekly-planning/drift-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV === "development";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function runDailyNotifications(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Daily notification run is not authorized." }, { status: 401 });
  }

  const [
    birthdayResponse,
    contractRenewalResponse,
    vacationSla,
    marketingSla,
    recruitment,
    telegramDigest,
    outstationGeocodeWarmup,
    outstationHighRisk,
    excuseSla,
    outstationSla,
    resignationSla,
    weeklyPlansDrift,
  ] = await Promise.all([
    runBirthdayNotifications(request),
    runContractRenewalNotifications(request),
    runVacationSlaDaily(),
    runMarketingSlaDaily(),
    runRecruitmentDailyNotifications(),
    runTelegramDailyHrDigest(),
    runOutstationGeocodeWarmup(),
    runOutstationHighRiskDigest(),
    runExcuseSlaDaily().catch((e) => ({ processed: 0, errors: 1, detail: String(e) })),
    runOutstationSlaDaily().catch((e) => ({ processed: 0, errors: 1, detail: String(e) })),
    runResignationSlaDaily().catch((e) => ({ processed: 0, errors: 1, detail: String(e) })),
    runWeeklyPlansDriftCheck().catch((e: unknown) => ({ ok: false as const, anomalies: 0 as const, driftCodes: [] as const, sentCount: 0 as const, error: String(e) })),
  ]);
  const [birthdays, contractRenewals] = await Promise.all([
    birthdayResponse.json(),
    contractRenewalResponse.json(),
  ]);

  return NextResponse.json({
    birthdays,
    contractRenewals,
    excuseSla,
    marketingSla,
    outstationGeocodeWarmup,
    outstationHighRisk,
    outstationSla,
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
        schedule: { type: "crontab", value: "0 4 * * *" },
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
