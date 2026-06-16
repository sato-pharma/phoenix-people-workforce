import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { runBirthdayNotifications } from "@/app/api/notifications/birthdays/route";
import { runContractRenewalNotifications } from "@/app/api/notifications/contract-renewals/route";
import { runVacationSlaDaily } from "@/lib/vacation/service";
import { runMarketingSlaDaily } from "@/lib/marketing-requests/service";
import { runRecruitmentDailyNotifications } from "@/lib/recruitment/notifications";
import { runTelegramDailyHrDigest } from "@/lib/notifications/telegram-operations";
import { runOutstationHighRiskDigest } from "@/lib/outstation/high-risk-digest";

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
    outstationHighRisk,
  ] = await Promise.all([
    runBirthdayNotifications(request),
    runContractRenewalNotifications(request),
    runVacationSlaDaily(),
    runMarketingSlaDaily(),
    runRecruitmentDailyNotifications(),
    runTelegramDailyHrDigest(),
    runOutstationHighRiskDigest(),
  ]);
  const [birthdays, contractRenewals] = await Promise.all([
    birthdayResponse.json(),
    contractRenewalResponse.json(),
  ]);

  return NextResponse.json({
    birthdays,
    contractRenewals,
    marketingSla,
    outstationHighRisk,
    recruitment,
    success: true,
    telegramDigest,
    vacationSla,
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
