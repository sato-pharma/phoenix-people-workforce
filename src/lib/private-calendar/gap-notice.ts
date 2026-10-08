/**
 * Private Calendar — the weekly "your own calendar has an unexplained day" notice, sent.
 *
 * The I/O half of `gap-notice-rules.ts`. Owner, 2026-10-08: "add an employee notice when his own
 * calendar has an unexplained day", after the measurement that the Request review control had been
 * used ONCE since 22 July across 111 active employees — not because it is hidden or wrongly gated,
 * but because nothing in the system ever told an employee to look at it.
 *
 * It judges nothing of its own — see the rules file. The days come from `getCompanyNoActivityDays`,
 * which is the SAME engine call the Deductions module's No Records Activity connector makes and the
 * same `derivePrivateCalendarExceptions` the employee's own calendar renders. No detector re-runs
 * here, no threshold lives here, and no table the calendar does not read is read here.
 *
 * ## Who it reaches
 *
 * The employee, about their OWN days, and nobody else. Not the manager, not HR, not a digest to an
 * admin: this is a nudge to the one person who can answer it, and a copy to a manager would turn a
 * recording gap into an accusation before anyone has asked. One notice per employee per week, not one
 * per day, because five separate notices about one week teach the bell to be ignored.
 *
 * ## Channels, and why it is never email
 *
 * In-app and push only. Bulk outbound email from a business system is banned (owner rule), and every
 * automated email in Phoenix also mirrors to the owner's Telegram — so a weekly sweep over the roster
 * on the email channel would both spam the staff and page the owner dozens of times a week for news
 * that is not his. Push is per-subscription and opt-in, so it reaches only employees who asked for it.
 *
 * ## A day already under review is never named
 *
 * The suppression read is fail-CLOSED: if `private_calendar_data_disputes` cannot be read, the run
 * throws rather than sending. A notice is unretractable and a retry is free, so the one thing this
 * must never do is nag an employee about the exact day they have already done the right thing on while a
 * Super Admin decision is pending.
 *
 * Never run from a laptop: it is a production cron, and a hand-run spends the week's idempotency key.
 */

import { systemAccessContext } from "@/lib/auth/permissions";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import {
  bundleGapNoticesByEmployee,
  composeGapNotice,
  gapNoticeDayKey,
  gapNoticeIdempotencyKey,
  gapNoticeWindow,
  type GapNotice,
  type GapNoticeDay,
  type GapNoticeWindow,
} from "@/lib/private-calendar/gap-notice-rules";
import { getCompanyNoActivityDays } from "@/lib/private-calendar/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Where the notice sends them. The page takes no date parameter and always opens on the current Cairo
 * month, so the dates travel in the message text — see the rules file's composer.
 */
const PRIVATE_CALENDAR_PATH = "/employee-portals/private-calendar";

export type GapNoticeDelivery = {
  employeeHrId: string;
  employeeName: string;
  notice: GapNotice;
  /** The window end (YYYY-MM-DD) — the stable part of the per-week idempotency key. */
  weekKey: string;
};

export type PrivateCalendarGapNoticeRun = {
  window: GapNoticeWindow;
  /** Unexplained days the engine returned for the week, across the whole active roster. */
  unexplainedDays: number;
  /** Of those, days already carrying a review request — named to nobody. */
  suppressedDays: number;
  employeesNotified: number;
  delivered: number;
  failed: number;
};

/**
 * Every day in the window an employee has ALREADY raised a review request for, whatever its status.
 *
 * Any status, deliberately. A pending one must not be nagged about; an accepted one is settled; and a
 * rejected one has been answered by a Super Admin in person, so re-raising it weekly would argue with
 * that decision through the bell.
 */
async function loadAlreadyRaisedDays(window: GapNoticeWindow): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .select("employee_hr_id,dispute_date")
    .gte("dispute_date", window.fromIso)
    .lte("dispute_date", window.toIso);

  // Fail closed. Sending without this read is the one unretractable mistake available here.
  if (error) throw new Error(`Could not read existing review requests: ${error.message}`);

  const raised = new Set<string>();
  for (const row of (data ?? []) as Array<{ dispute_date: string | null; employee_hr_id: string | null }>) {
    if (!row.employee_hr_id || !row.dispute_date) continue;
    raised.add(gapNoticeDayKey({ date: row.dispute_date, employeeHrId: row.employee_hr_id }));
  }
  return raised;
}

async function deliver(delivery: GapNoticeDelivery): Promise<void> {
  await createSystemNotification({
    actionUrl: PRIVATE_CALENDAR_PATH,
    // In-app and push. Never email — see the header.
    channels: ["in_app", "push"],
    eventType: "private_calendar_gap_notice",
    message: delivery.notice.message,
    metadata: {
      // Per employee per WEEK: the cron can be retried or double-fired, and none of those may reach
      // anyone twice. Keyed on the window end, so a new week is a new notice and a retry of this one
      // is not — independent of the message text, which a late-arriving punch could still change.
      idempotencyKey: gapNoticeIdempotencyKey({ employeeHrId: delivery.employeeHrId, windowEndIso: delivery.weekKey }),
      dates: delivery.notice.dates,
    },
    module: "private_calendar",
    priority: "normal",
    // The employee is both the recipient and the subject: this is their own calendar, and the governed
    // path must never widen it to a manager.
    recipientHrId: delivery.employeeHrId,
    subjectHrId: delivery.employeeHrId,
    title: delivery.notice.title,
  });
}

/**
 * One pass of the weekly notice. Never throws for a single failed delivery: one employee with a broken
 * push subscription must not cost the rest of the roster their notice.
 */
export async function runPrivateCalendarGapNotice(
  send: (delivery: GapNoticeDelivery) => Promise<void> = deliver,
): Promise<PrivateCalendarGapNoticeRun> {
  const window = gapNoticeWindow(currentCairoDateOnlyIso());

  const days: GapNoticeDay[] = (
    await getCompanyNoActivityDays({ access: systemAccessContext, end: window.toIso, start: window.fromIso })
  ).map((day) => ({ date: day.date, employeeHrId: day.employeeHrId, employeeName: day.employeeName }));

  const alreadyRaised = await loadAlreadyRaisedDays(window);
  const bundles = bundleGapNoticesByEmployee({ alreadyRaised, days });
  const suppressedDays = days.length - bundles.reduce((total, bundle) => total + bundle.days.length, 0);

  let delivered = 0;
  let failed = 0;
  for (const bundle of bundles) {
    try {
      await send({
        employeeHrId: bundle.employeeHrId,
        employeeName: bundle.employeeName,
        notice: composeGapNotice({ days: bundle.days, employeeName: bundle.employeeName, window }),
        weekKey: window.toIso,
      });
      delivered += 1;
    } catch (error) {
      failed += 1;
      logError("Private Calendar gap notice delivery failed", {
        error,
        labels: { event: "private_calendar_gap_notice_failed", job: "private-calendar-gap-notice" },
      });
    }
  }

  return {
    window,
    unexplainedDays: days.length,
    suppressedDays,
    employeesNotified: bundles.length,
    delivered,
    failed,
  };
}
