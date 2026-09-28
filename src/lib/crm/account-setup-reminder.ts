/**
 * New-hire CRM account setup — the reminder for a task nobody acted on.
 *
 * `account-setup-notify.ts` tells the SFE Manager ONCE, the moment the employee is added, and then
 * nothing ever speaks again. Measured 2026-09-28: seven tasks were open, the oldest for eight days,
 * and five medical reps could not use Phoenix CRM at all because of them — with no iReports360
 * account there are no contacts to carry over, so the rep has no customer list, and with no list he
 * can neither plan a visit nor record one. Nothing anywhere was red. The single notice had been sent
 * days earlier and scrolled away.
 *
 * So this runs daily with the rest of the SLA nudges (`/api/notifications/daily`, 06:36 Cairo). It
 * adds no schedule of its own ON PURPOSE: a new `JOB_SCHEDULES` declaration whose cron job does not
 * exist reads to `job-heartbeat-assess` as a job that has STOPPED and Telegrams every Super Admin
 * about it for ever (AGENTS.md §4, the 06:55 digest). Riding an existing job has no such edge.
 *
 * 🔴 A CLEAN QUEUE TELLS NOBODY, and neither does a task opened today. A reminder that arrives every
 * morning whatever the state is muted inside a week, and a muted reminder is worse than none because
 * everybody believes it is working — the same rule the owner set for the 06:55 CRM digest. A task
 * has to be `REMINDER_AFTER_DAYS` old before it is worth anyone's morning.
 *
 * IN-APP AND TELEGRAM, NEVER EMAIL. The first notice already emails; a second daily email about the
 * same person would be the thing that gets the whole module filtered. Telegram was dead for this
 * module until 2026-09-28 (no policy at all, so the unknown-module fail-safe disabled it) — that is
 * fixed, and it is why this can rely on it.
 */

import { getCrmAccountSetupQueue, type CrmAccountSetupTaskRow } from "@/lib/crm/account-setup";
import { CRM_ACCOUNT_SETUP_AUDIENCE, CRM_ACCOUNT_SETUP_MODULE } from "@/lib/crm/account-setup-messages";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";

/** A task younger than this is not late yet: the first notice is still the freshest thing said. */
export const REMINDER_AFTER_DAYS = 2;

/** Where the reminder lands: the board that asks for the CRM username and code. */
export const CRM_ACCOUNT_SETUP_REMINDER_PATH = "/admin/crm";

export type CrmAccountSetupReminderRun = {
  pending: number;
  /** Open at least REMINDER_AFTER_DAYS — the ones this reminder is about. */
  overdue: number;
  recipients: number;
  delivered: number;
  skippedReason: string | null;
};

/** Whole days between the day a task was opened and today, in Cairo. Negative clock skew reads 0. */
export function daysOpen(openedAt: string, cairoToday: string): number {
  const opened = Date.parse(`${String(openedAt).slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${cairoToday}T00:00:00Z`);
  if (!Number.isFinite(opened) || !Number.isFinite(today)) return 0;
  return Math.max(0, Math.round((today - opened) / 86_400_000));
}

/** The open tasks worth a reminder this morning, oldest first. */
export function overdueTasks(pending: ReadonlyArray<CrmAccountSetupTaskRow>, cairoToday: string): CrmAccountSetupTaskRow[] {
  return pending
    .filter((task) => daysOpen(task.openedAt, cairoToday) >= REMINDER_AFTER_DAYS)
    .sort((left, right) => daysOpen(right.openedAt, cairoToday) - daysOpen(left.openedAt, cairoToday));
}

/** The words. One line per person, oldest first, and the cost said plainly rather than implied. */
export function reminderMessage(tasks: ReadonlyArray<CrmAccountSetupTaskRow>, cairoToday: string): string {
  const lines = tasks.map((task) => {
    const days = daysOpen(task.openedAt, cairoToday);
    const where = [task.subject.areaName, task.subject.lineName].filter(Boolean).join(" · ");
    return `• ${task.subject.displayName}${where ? ` — ${where}` : ""} — waiting ${days} day${days === 1 ? "" : "s"}`;
  });
  return [
    `${tasks.length} new ${tasks.length === 1 ? "person is" : "people are"} still waiting for an iReports360 account.`,
    "",
    ...lines,
    "",
    "A medical rep with no iReports360 account has no customer list in Phoenix CRM, so he can neither plan a visit nor record one. Once the account exists the contacts sync and the list appears by itself.",
    "",
    "Open Phoenix CRM admin and enter each person's CRM username and code.",
  ].join("\n");
}

/**
 * One pass. Never throws: it runs beside twenty other daily nudges and must not take them down.
 */
export async function runCrmAccountSetupReminder(): Promise<CrmAccountSetupReminderRun> {
  const cairoToday = currentCairoDateOnlyIso();
  try {
    const queue = await getCrmAccountSetupQueue();
    if (queue.schemaMissing) return { pending: 0, overdue: 0, recipients: 0, delivered: 0, skippedReason: "schema_missing" };

    const overdue = overdueTasks(queue.pending, cairoToday);
    // The good outcome. Nothing is sent, and nothing needs to be.
    if (overdue.length === 0) {
      return { pending: queue.pending.length, overdue: 0, recipients: 0, delivered: 0, skippedReason: "nothing_overdue" };
    }

    const { recipients, warnings } = await resolveNotificationPersonRecipients(CRM_ACCOUNT_SETUP_AUDIENCE, "crm account setup reminder");
    for (const warning of warnings) logError("CRM account setup reminder recipient warning", { labels: { event: "crm_account_setup_reminder_recipients" }, error: warning });
    const hrIds = recipients.map((person) => person.hrId).filter((hrId): hrId is string => Boolean(hrId));
    if (hrIds.length === 0) {
      return { pending: queue.pending.length, overdue: overdue.length, recipients: 0, delivered: 0, skippedReason: "no_recipients" };
    }

    await createSystemNotificationForRecipients(
      {
        actionUrl: CRM_ACCOUNT_SETUP_REMINDER_PATH,
        category: "crm",
        // In-app and Telegram. Never email — see the header.
        channels: ["in_app", "telegram"],
        eventType: "crm_account_setup_reminder",
        message: reminderMessage(overdue, cairoToday),
        // Per DAY, so a second run of the daily job cannot send it twice, and so tomorrow's is new.
        metadata: { idempotencyKey: `crm_account_setup:reminder:${cairoToday}` },
        module: CRM_ACCOUNT_SETUP_MODULE,
        priority: "normal",
        subjectHrId: overdue[0]?.subject.hrId ?? null,
        telegram: { ctaLabel: "Open CRM admin", ctaUrl: CRM_ACCOUNT_SETUP_REMINDER_PATH },
        title: `${overdue.length} ${overdue.length === 1 ? "person is" : "people are"} waiting for an iReports360 account`,
      },
      hrIds,
    );

    return { pending: queue.pending.length, overdue: overdue.length, recipients: hrIds.length, delivered: hrIds.length, skippedReason: null };
  } catch (error) {
    logError("CRM account setup reminder failed", { labels: { event: "crm_account_setup_reminder_failed" }, error });
    return { pending: 0, overdue: 0, recipients: 0, delivered: 0, skippedReason: "error" };
  }
}
