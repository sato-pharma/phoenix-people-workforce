import { NextResponse } from "next/server";

import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationRoleRecipients } from "@/lib/notifications/role-recipients";
import { runScheduledNotificationProcessing } from "@/lib/notifications/scheduled-processing";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  cairoTodayIso,
  getUpcomingUnconfirmedHolidays,
  HOLIDAY_CONFIRMATION_LEAD_DAYS,
  type PendingHolidayConfirmation,
} from "@/lib/vacation/holiday-confirmation";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveSystemAdminRecipients() {
  const roles = await resolveNotificationRoleRecipients("holiday_confirmation_reminder");
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id,hr_id")
    .in("role", roles)
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
  // The page is /attendance/holiday-calendar — NOT /admin/attendance/... . It reads `?confirm=`
  // and even loads the year that date falls in, so the deep link works in full; only this prefix
  // was stale, left behind when the page moved out of /admin. Three of these went out (most
  // recently 2026-08-24) and every one 404'd. next.config.ts redirects the old spelling so the
  // notifications already sitting in inboxes work too.
  const actionUrl = `/attendance/holiday-calendar?confirm=${encodeURIComponent(holiday.officialDate)}`;
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
  const denied = assertCronAuthorized(request, "notifications/holiday-confirmation", {
    message: "Holiday confirmation reminder run is not authorized.",
  });
  if (denied) return denied;

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
    // Isolated per holiday: one bad send (e.g. a transient email/network error)
    // must not abort the loop and skip every remaining holiday in this run —
    // it will simply be retried on tomorrow's run since nothing gets confirmed.
    try {
      await notifyRecipientsOfPendingHoliday(holiday, recipients, runDate);
      results.push({ holiday, result: { recipientCount: recipients.length, sent: true } });
    } catch (error) {
      results.push({
        holiday,
        result: { error: clientSafeErrorMessage(error, "Holiday confirmation reminder failed."), sent: false },
      });
    }
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
  const denied = assertCronAuthorized(request, "notifications/holiday-confirmation", {
    message: "Holiday confirmation reminder run is not authorized.",
  });
  if (denied) return denied;
  try {
    return await runHolidayConfirmationReminder(request);
  } catch (error) {
    console.error(error, { tags: { cron: "holiday-confirmation" } });
    const message = clientSafeErrorMessage(error, "Holiday confirmation reminder run failed.");
    return NextResponse.json({ error: "holiday_confirmation_reminder_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
