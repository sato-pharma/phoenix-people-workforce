import {
  createSystemNotification,
  type SystemNotificationChannel,
} from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { AUTOMATED_PAYROLL_NOTIFY_ROLES } from "./permissions.ts";
import type { MonthlySalaryRun } from "./types.ts";

/**
 * Notifies CEO + Financial Advisor + Finance Manager at each milestone. Uses an
 * explicit role set (permissions.ts) resolved to active users directly — no edit
 * to the shared notification-role-policy registry. Per-recipient idempotency keys
 * make re-fires safe.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthLabel(month: number, year: number): string {
  return `${MONTHS[Math.max(0, Math.min(11, month - 1))]} ${year}`;
}

async function resolveRecipients(): Promise<string[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("hr_id, role, is_active")
      .in("role", [...AUTOMATED_PAYROLL_NOTIFY_ROLES])
      .eq("is_active", true);
    if (error) {
      logError("Automated payroll: notification recipient lookup failed", {
        labels: { event: "automated_payroll_notify_recipient_lookup_failed" },
        error,
      });
      return [];
    }
    const hrIds = new Set<string>();
    for (const row of (data ?? []) as Array<{ hr_id: string | null }>) {
      const hrId = String(row.hr_id ?? "").trim();
      if (hrId) hrIds.add(hrId);
    }
    return [...hrIds];
  } catch (error) {
    logError("Automated payroll: notification recipient lookup threw an exception", {
      labels: { event: "automated_payroll_notify_recipient_lookup_threw" },
      error,
    });
    return [];
  }
}

const FINANCE_URL = "/admin/automated-payroll/finance";

async function fanOut(input: {
  run: MonthlySalaryRun;
  eventType: string;
  title: string;
  message: string;
  channels: SystemNotificationChannel[];
}): Promise<void> {
  const recipients = await resolveRecipients();
  await Promise.all(
    recipients.map((recipientHrId) =>
      createSystemNotification({
        module: "payroll",
        eventType: input.eventType,
        title: input.title,
        message: input.message,
        recipientHrId,
        actionUrl: FINANCE_URL,
        channels: input.channels,
        priority: "high",
        metadata: {
          idempotencyKey: `${input.eventType}:${recipientHrId}:${input.run.monthKey}`,
          month: input.run.month,
          year: input.run.year,
          runId: input.run.id,
        },
      }).catch((error) => {
        logError("Automated payroll: notification send failed", {
          labels: {
            event: "automated_payroll_notify_send_failed",
            notifyEvent: input.eventType,
            hrId: recipientHrId,
            runId: input.run.id,
          },
          error,
        });
      }),
    ),
  );
}

/** Part 1 confirmed — email + in-app only. */
export async function notifyPart1Ready(run: MonthlySalaryRun): Promise<void> {
  const label = monthLabel(run.month, run.year);
  await fanOut({
    run,
    eventType: "automated_payroll_part1_ready",
    title: `${label} Payroll — Part 1 ready`,
    message: `${label} Automated Payroll Part 1 is HR-confirmed and ready for your review and finance execution. Open the finance tab to download the Part 1 sheet.`,
    channels: ["in_app", "email", "push"],
  });
}

/** Part 2 confirmed — email + Telegram + in-app. */
export async function notifyPart2Ready(run: MonthlySalaryRun): Promise<void> {
  const label = monthLabel(run.month, run.year);
  await fanOut({
    run,
    eventType: "automated_payroll_part2_ready",
    title: `${label} Payroll — Part 2 ready`,
    message: `${label} Automated Payroll Part 2 is HR-confirmed. The full monthly sheet is ready for review. Awaiting System Admin publish to payslips.`,
    channels: ["in_app", "email", "telegram", "push"],
  });
}

/** Published to payslips — light in-app + email confirmation. */
export async function notifyPublished(run: MonthlySalaryRun): Promise<void> {
  const label = monthLabel(run.month, run.year);
  await fanOut({
    run,
    eventType: "automated_payroll_published",
    title: `${label} Payroll — published to payslips`,
    message: `${label} Automated Payroll has been published to payslips.`,
    channels: ["in_app", "email", "push"],
  });
}
