import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { getContractRenewalReminderCandidates } from "@/lib/contracts/service";
import { lifecycleRiskWindows } from "@/lib/lifecycle-risk/metrics";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { runScheduledNotificationProcessing } from "@/lib/notifications/scheduled-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cairoDate() {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
}

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV === "development";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function runContractRenewalNotifications(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Contract renewal notification run is not authorized." }, { status: 401 });
  }

  const runDate = cairoDate();
  const candidates = await getContractRenewalReminderCandidates([
    lifecycleRiskWindows.contractUpcomingDays,
    lifecycleRiskWindows.contractRiskDays,
    lifecycleRiskWindows.contractCriticalDays,
    0,
  ]);
  const results = [];

  for (const row of candidates) {
    const dueText = row.daysUntil === 0 ? "due today" : `due in ${row.daysUntil} days`;
    const result = await safeSendNotificationEmail({
      employeeHrId: row.hr_id,
      metrics: [
        { label: "Employee", value: `${row.full_name} (${row.hr_id})` },
        { label: "Renewal date", value: row.contract_renewal_date },
        { label: "Reminder", value: dueText },
        { label: "Run date", value: runDate },
      ],
      notificationType: "contract_renewal",
      subject: `Contract Renewal Reminder - ${row.full_name} - ${row.contract_renewal_date}`,
      summary: `Contract renewal for ${row.full_name} is ${dueText}. Pending manager recommendation is required.`,
      title: "Contract Renewal Reminder - Pending Manager Recommendation",
      tone: row.daysUntil <= 7 ? "danger" : "warning",
    });

    results.push({ daysUntil: row.daysUntil, employeeHrId: row.hr_id, result });
  }

  const processing = await runScheduledNotificationProcessing(10);

  return NextResponse.json({
    matched: candidates.length,
    processing,
    results,
    runDate,
  });
}

export async function GET(request: Request) {
  // Only authorized cron runs are monitored, so unrelated pings don't record check-ins.
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Contract renewal notification run is not authorized." }, { status: 401 });
  }
  try {
    // Sentry cron monitor: a missed or failed daily run raises an alert (email).
    // This run also processes the notification outbox + probation reminders.
    return await Sentry.withMonitor(
      "contract-renewals",
      () => runContractRenewalNotifications(request),
      {
        schedule: { type: "crontab", value: "15 4 * * *" },
        checkinMargin: 60,
        maxRuntime: 30,
        timezone: "Etc/UTC",
      },
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { cron: "contract-renewals" } });
    const message = error instanceof Error ? error.message : "Contract renewal notification run failed.";
    return NextResponse.json({ error: "contract_renewal_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
