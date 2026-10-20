/**
 * The daily mailbox-offboarding sweep — the safety net under the exit workflow.
 *
 * WHY A SWEEP AT ALL, when the exit workflow already opens a task. Because the exit workflow is
 * best-effort by design: a mailbox task must never be the reason a resignation fails to record.
 * So the open is wrapped and swallowed at the call
 * site, and something has to notice when it did not happen. Without this, a swallowed failure is
 * indistinguishable from "nobody has left" — which is precisely the shape that let 52 mailboxes
 * accumulate with nothing anywhere reporting them.
 *
 * WHAT IT ALERTS ON — three conditions, deliberately not one:
 *
 *   overdue           — the last working day has passed and the mailbox is still not revoked.
 *   half-revoked      — the password was reset and the app passwords were NOT cleared. This one is
 *                       the reason the alert is not simply "overdue": it looks finished in the
 *                       control panel, the admin believes it is done, and every phone and Outlook
 *                       client the leaver configured is still connected. Yahoo app passwords
 *                       survive a password change. Nothing but this alert will ever surface it.
 *   forwarding lapsed — forwarding set at an exit whose expiry has passed, still delivering.
 *
 * DELIBERATELY NOT EMAILED. AGENTS.md §4: "Before wiring any email recipients, ask who receives
 * it." The owner has not been asked, so this ships in-app and by Telegram — the channels the
 * existing operational alerts use — and email can be added the moment he names recipients. The
 * recipients themselves are not a new decision either: this reuses `resignation_workflow_alert`,
 * which he set to Super Admin and HR Operations on 2026-08-09 and which is editable at
 * /admin/notification-recipients. A leaver's mailbox is resignation workflow. The HR Operations
 * Specialist seat joined that audience on 2026-10-20 and is filtered back out here — see the sweep.
 *
 * BUCKETED PER CAIRO DAY AND PER EXACT SET, mirroring the drain-stranded alarm. A backlog that
 * persists across days alerts once a day rather than every run, while a NEWLY overdue mailbox
 * changes the set and therefore still gets through the same day it appears.
 */

import { HR_OPERATIONS_SPECIALIST_SEAT } from "@/lib/auth/hr-functions";
import { resolveNotificationRoleRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  getMailboxOffboardingDashboardData,
  mailboxOffboardingErrorMessage,
  openMailboxOffboardingTask,
} from "./service";
import type { MailboxOffboardingTask } from "./types";

/**
 * The page this alert links to. Gated on `mailbox_offboarding` read — which every role this alert
 * is sent to holds (Super Admin has everything; HR Operations owns the register). The HR Operations
 * Specialist seat, which is on `resignation_workflow_alert` but holds no such grant, is dropped.
 * Checked deliberately: an actionUrl pointing at a screen the recipient is 403'd from is a defect
 * this repository has shipped before.
 */
const MAILBOX_OFFBOARDING_HREF = "/mailbox-offboarding";

export type MailboxSweepResult = {
  opened: number;
  overdue: number;
  halfRevoked: number;
  forwardingExpired: number;
  notified: number;
  errors: number;
};

/**
 * A stable signature of what is wrong right now. Two runs finding the same tasks in the same
 * states produce the same string, so the idempotency key suppresses the repeat; one more overdue
 * mailbox changes it and the alert lands.
 *
 * Sorted, because PostgREST row order is not a contract and an unsorted signature would alert on
 * a reordering that changed nothing.
 */
export function buildMailboxAlertSignature(tasks: MailboxOffboardingTask[]): string {
  return tasks
    .map((task) => `${task.id}:${task.status}:${task.isHalfRevoked ? "half" : "full"}`)
    .sort()
    .join("|");
}

/** Short, stable hash of the signature — an idempotency key must not be unbounded in length. */
function signatureKey(signature: string): string {
  let hash = 0;
  for (let index = 0; index < signature.length; index += 1) {
    hash = (hash * 31 + signature.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function describe(task: MailboxOffboardingTask): string {
  if (task.isHalfRevoked) {
    return `${task.employeeName} — ${task.workEmail}: password reset, app passwords NOT cleared (phone and Outlook still connected)`;
  }
  if (task.isForwardingExpired) {
    return `${task.employeeName} — ${task.workEmail}: forwarding to ${task.forwardingTo} expired on ${task.forwardingExpiresOn}`;
  }
  return `${task.employeeName} — ${task.workEmail}: not revoked, ${task.daysOverdue} day${
    task.daysOverdue === 1 ? "" : "s"
  } past the last working day`;
}

export async function runMailboxOffboardingSweep(): Promise<MailboxSweepResult> {
  const result: MailboxSweepResult = {
    opened: 0,
    overdue: 0,
    halfRevoked: 0,
    forwardingExpired: 0,
    notified: 0,
    errors: 0,
  };

  let data;
  try {
    data = await getMailboxOffboardingDashboardData();
  } catch (error) {
    logError("Mailbox offboarding sweep could not read the register", {
      labels: { event: "mailbox_offboarding_sweep_failed", cron: "mailbox-offboarding-sweep" },
      error,
    });
    return { ...result, errors: 1 };
  }

  // 1. Close the gap the exit workflow may have left.
  for (const leaver of data.awaiting) {
    try {
      const taskId = await openMailboxOffboardingTask(leaver.employeeHrId, "system:mailbox-sweep", "sweep");
      if (taskId) result.opened += 1;
    } catch (error) {
      result.errors += 1;
      logError("Mailbox offboarding sweep could not open a task", {
        labels: { event: "mailbox_offboarding_open_failed", cron: "mailbox-offboarding-sweep" },
        context: { employeeHrId: leaver.employeeHrId, message: mailboxOffboardingErrorMessage(error) },
        error,
      });
    }
  }

  // Re-read only when the sweep actually changed something, so a quiet day costs one query.
  const register = result.opened > 0 ? await getMailboxOffboardingDashboardData() : data;

  const flagged = register.tasks.filter(
    (task) => task.isOverdue || task.isHalfRevoked || task.isForwardingExpired,
  );
  result.overdue = register.stats.overdue;
  result.halfRevoked = register.stats.halfRevoked;
  result.forwardingExpired = register.stats.forwardingExpired;

  if (flagged.length === 0) return result;

  const today = currentCairoDateOnlyIso();
  const bucket = signatureKey(buildMailboxAlertSignature(flagged));

  // The resignation audience MINUS the HR Operations Specialist seat (owner, 2026-10-20). That seat
  // joined `resignation_workflow_alert` to follow each resignation through, but closing a leaver's
  // mailbox is the register the HR Generalist and the Super Admin keep: the seat holds no
  // `mailbox_offboarding` grant, so this alert's link would only open a refusal for her. The HR
  // Generalist's copy, while that seat is empty, is the Super Admin's (vacant-seat.ts).
  const roles = (await resolveNotificationRoleRecipients("resignation_workflow_alert")).filter(
    (role) => role !== HR_OPERATIONS_SPECIALIST_SEAT,
  );
  const supabase = getSupabaseAdmin();
  const { data: recipients } = await supabase
    .from("app_auth_users")
    .select("hr_id")
    .in("role", roles)
    .eq("is_active", true);

  const recipientHrIds = (recipients ?? [])
    .map((row) => String((row as { hr_id?: unknown }).hr_id ?? ""))
    .filter((hrId) => hrId.length > 0);

  // The half-revoked ones lead, because they are the ones nobody would otherwise find.
  const lines = [...flagged]
    .sort((left, right) => Number(right.isHalfRevoked) - Number(left.isHalfRevoked))
    .map(describe);

  const headline =
    result.halfRevoked > 0
      ? `${result.halfRevoked} mailbox${result.halfRevoked === 1 ? "" : "es"} still reachable after a password reset`
      : `${flagged.length} leaver mailbox${flagged.length === 1 ? "" : "es"} not yet revoked`;

  for (const hrId of recipientHrIds) {
    try {
      await createSystemNotification({
        channels: ["in_app", "telegram"],
        eventType: "mailbox_offboarding_overdue",
        module: "mailbox_offboarding",
        priority: "high",
        recipientHrId: hrId,
        title: headline,
        message: lines.join("\n"),
        actionUrl: MAILBOX_OFFBOARDING_HREF,
        metadata: { idempotencyKey: `mailbox-offboarding:${today}:${bucket}:${hrId}` },
        telegram: { ctaLabel: "Open the mailbox register", ctaUrl: MAILBOX_OFFBOARDING_HREF },
      });
      result.notified += 1;
    } catch (error) {
      result.errors += 1;
      logError("Mailbox offboarding alert failed for recipient", {
        labels: { event: "mailbox_offboarding_alert_failed", cron: "mailbox-offboarding-sweep", recipientHrId: hrId },
        error,
      });
    }
  }

  return result;
}
