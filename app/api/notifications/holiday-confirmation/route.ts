import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { systemAdministratorRoles } from "@/lib/auth/permissions";
import { createSystemNotification } from "@/lib/notifications/system";
import { runScheduledNotificationProcessing } from "@/lib/notifications/scheduled-processing";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  cairoTodayIso,
  getUpcomingUnconfirmedHolidays,
  HOLIDAY_CONFIRMATION_LEAD_DAYS,
  type PendingHolidayConfirmation,
} from "@/lib/vacation/holiday-confirmation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Every Vercel environment (production, preview, `vercel dev`) sets VERCEL — only a
  // real local machine without it may bypass an unset CRON_SECRET during development.
  if (!secret) return !process.env.VERCEL && process.env.NODE_ENV === "development";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function resolveSystemAdminRecipients() {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id,hr_id")
    .in("role", [...systemAdministratorRoles])
    .eq("is_active", true);
  if (error) return [];
  return ((data ?? []) as Array<{ hr_id?: string | null; login_id?: string | null }>).map((row) => ({
    hrId: row.hr_id ?? null,
    userId: row.login_id ?? null,
  }));
}

async function notifyRecipientsOfPendingHoliday(
  holiday: PendingHolidayConfirmation,
  recipients: Array<{ hrId: string | null; userId: string | null }>,
  runDate: string,
) {
  const actionUrl = `/admin/attendance/holiday-calendar?confirm=${encodeURIComponent(holiday.officialDate)}`;
  const summary = `${holiday.name} is officially dated ${holiday.officialDate} (in ${holiday.daysUntil} days). Confirm whether the observed day off is the same date or postponed — ministry announcements sometimes move the real day off (e.g. June 30 Revolution Day observed July 2). Once confirmed, the date is published to every calendar, weekly/monthly plan, vacation, and attendance check.`;

  await Promise.all(recipients.map((recipient) => createSystemNotification({
    actionUrl,
    actorId: "system",
    email: {
      ctaHref: actionUrl,
      ctaLabel: "Confirm the holiday date",
      metrics: [
        { label: "Holiday", value: holiday.name },
        { label: "Official date", value: holiday.officialDate },
        { label: "Days until", value: String(holiday.daysUntil) },
        { label: "Run date", value: runDate },
      ],
      notificationType: "general",
      subject: `Confirm national holiday: ${holiday.name} (${holiday.officialDate})`,
      summary,
      title: "National holiday needs confirmation",
      tone: "warning",
    },
    eventType: "holiday_confirmation_reminder",
    message: summary,
    metadata: {
      actionUrl,
      daysUntil: holiday.daysUntil,
      holidayName: holiday.name,
      idempotencyKey: `holiday-confirmation-reminder:${holiday.officialDate}:${runDate}`,
      officialDate: holiday.officialDate,
    },
    module: "holiday_confirmation",
    priority: "high",
    recipientHrId: recipient.hrId,
    recipientUserId: recipient.userId,
    title: "National holiday needs confirmation",
  })));
}

export async function runHolidayConfirmationReminder(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Holiday confirmation reminder run is not authorized." }, { status: 401 });
  }

  const runDate = cairoTodayIso();
  const [pendingHolidays, recipients] = await Promise.all([
    getUpcomingUnconfirmedHolidays(HOLIDAY_CONFIRMATION_LEAD_DAYS),
    resolveSystemAdminRecipients(),
  ]);

  const results = [];
  for (const holiday of pendingHolidays) {
    if (recipients.length === 0) {
      results.push({
        holiday,
        result: { skipped: true, warning: "No active System Admin recipient resolved — holiday confirmation reminder not sent." },
      });
      continue;
    }
    await notifyRecipientsOfPendingHoliday(holiday, recipients, runDate);
    results.push({ holiday, result: { recipientCount: recipients.length, sent: true } });
  }

  const processing = await runScheduledNotificationProcessing(10);

  return NextResponse.json({
    matched: pendingHolidays.length,
    processing,
    results,
    runDate,
  });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Holiday confirmation reminder run is not authorized." }, { status: 401 });
  }
  try {
    // NOTE: no Sentry cron monitor here. This sub-route runs in-process from the single
    // daily dispatcher (/api/notifications/daily), which calls
    // runHolidayConfirmationReminder() directly — never this GET handler — so a per-route
    // monitor would never check in and would raise false missed-run alerts.
    // The dispatcher owns the cron monitor.
    return await runHolidayConfirmationReminder(request);
  } catch (error) {
    Sentry.captureException(error, { tags: { cron: "holiday-confirmation" } });
    const message = error instanceof Error ? error.message : "Holiday confirmation reminder run failed.";
    return NextResponse.json({ error: "holiday_confirmation_reminder_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
