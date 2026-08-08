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

/**
 * Fixed To/Cc list for the Part-1-submitted-for-review email (owner request,
 * 2026-07-26): To Adel El Sayed (Financial Advisor) + Ahmed El Maraghy (Admin
 * Manager), Cc Anwar Gaweesh (CEO). Distinct from notifyPart1Ready's role-based
 * fan-out below — this is one consolidated email with a specific To/Cc shape,
 * not a per-recipient milestone notice. HR_ID is the stable key; work_email is
 * resolved live so an address change never requires a code edit.
 */
const PART1_REVIEW_TO_HR_IDS = ["OF-0002", "B-185"] as const; // Adel El Sayed, Ahmed El Maraghy
const PART1_REVIEW_CC_HR_ID = "AA"; // Anwar Gaweesh

async function resolveWorkEmail(hrId: string): Promise<string | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("work_email")
      .eq("hr_id", hrId)
      .maybeSingle();
    if (error) throw error;
    return (data as { work_email?: string | null } | null)?.work_email ?? null;
  } catch (error) {
    logError("Automated payroll: Part 1 review email recipient lookup failed", {
      labels: { event: "automated_payroll_part1_review_email_recipient_lookup_failed", hrId },
      error,
    });
    return null;
  }
}

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
          // Bug found + fixed 2026-07-26: without this flag, every milestone
          // notification below (Part 1/2 ready, published) was silently
          // skipped on EVERY channel (email/push/in-app) — the "payroll"
          // module's explicit-recipient guard (system.ts's
          // explicitRecipientAllowed) requires the recipient to be the
          // notification's own subject UNLESS the caller opts in here.
          // resolveRecipients() above already does its own trusted,
          // role-gated lookup (CEO/Financial Advisor/Finance Manager) — this
          // is not a per-employee payslip, so there is no "subject" to
          // protect, and this is exactly the sanctioned bypass the guard's
          // own doc comment describes for a trusted server caller.
          authorizedRecipient: true,
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

/**
 * Part 1 confirmed — a distinct, always-fired email to the two people who
 * execute the bank transfer, To Adel + Ahmed, Cc Anwar, saying HR has
 * submitted Part 1 for review. Additive to notifyPart1Ready above (the
 * broader CEO/Financial Advisor/Finance Manager milestone notice) — this one
 * has a fixed, named To/Cc shape the owner asked for explicitly, so it does
 * not go through recipient governance or the generic email envelope.
 */
export async function notifyPart1SubmittedForReview(run: MonthlySalaryRun): Promise<void> {
  const label = monthLabel(run.month, run.year);
  const [toEmails, ccEmail] = await Promise.all([
    Promise.all(PART1_REVIEW_TO_HR_IDS.map((hrId) => resolveWorkEmail(hrId))),
    resolveWorkEmail(PART1_REVIEW_CC_HR_ID),
  ]);
  const recipients = toEmails.filter((email): email is string => Boolean(email));
  if (recipients.length === 0) {
    logError("Automated payroll: Part 1 review email has no deliverable recipients", {
      labels: { event: "automated_payroll_part1_review_email_no_recipients", runId: run.id },
    });
    return;
  }

  try {
    await createSystemNotification({
      module: "payroll",
      eventType: "automated_payroll_part1_submitted_review",
      title: `${label} Payroll — Part 1 submitted, pending your review`,
      message: `HR has submitted the ${label} payroll Part 1. It is pending your review.`,
      recipientHrId: PART1_REVIEW_TO_HR_IDS[0],
      actionUrl: FINANCE_URL,
      channels: ["email"],
      priority: "high",
      email: {
        recipients,
        cc: ccEmail ? [ccEmail] : undefined,
      },
      metadata: {
        // Same sanctioned bypass as fanOut() above: a trusted server caller with
        // its own fixed, named recipient list, not a per-employee payslip.
        authorizedRecipient: true,
        idempotencyKey: `automated_payroll_part1_submitted_review:${run.monthKey}`,
        month: run.month,
        year: run.year,
        runId: run.id,
      },
    });
  } catch (error) {
    logError("Automated payroll: Part 1 review email failed", {
      labels: { event: "automated_payroll_part1_review_email_failed", runId: run.id },
      error,
    });
  }
}

/** Part 2 confirmed — email + Telegram + in-app. */
export async function notifyPart2Ready(run: MonthlySalaryRun): Promise<void> {
  const label = monthLabel(run.month, run.year);
  await fanOut({
    run,
    eventType: "automated_payroll_part2_ready",
    title: `${label} Payroll — Part 2 ready`,
    // Must not contain the word "payslip" — email.ts's payloadLooksLikePayslip() hard-blocks
    // ANY email whose summary/title contains that substring, even ordinary admin prose (bug
    // found 2026-08-08: this exact sentence silently vanished the Part 2 milestone email).
    message: `${label} Automated Payroll Part 2 is HR-confirmed. The full monthly sheet is ready for review. Awaiting System Admin to publish this run.`,
    channels: ["in_app", "email", "telegram", "push"],
  });
}

/** Published to payslips — light in-app + email confirmation. */
export async function notifyPublished(run: MonthlySalaryRun): Promise<void> {
  const label = monthLabel(run.month, run.year);
  await fanOut({
    run,
    eventType: "automated_payroll_published",
    // Title and message must not contain the word "payslip" — see the note on notifyPart2Ready
    // above. This one was also silently blocked (never observed in production only because no
    // run has reached Publish since the guard's summary-scanning was added).
    title: `${label} Payroll — published`,
    message: `${label} Automated Payroll has been published and is now live for employees.`,
    channels: ["in_app", "email", "push"],
  });
}
